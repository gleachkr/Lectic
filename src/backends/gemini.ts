import type { Content, Part, ContentListUnion, Candidate, Model, Pager } from '@google/genai'
import type * as Gemini from '@google/genai' 
import { GoogleGenAI, GenerateContentResponse, ThinkingLevel, FunctionResponse } from '@google/genai'
import type { Message } from "../types/message"
import type { Lectic } from "../types/lectic"
import { serializeCall } from "../types/tool"
import { LLMProvider } from "../types/provider"
import type { Backend } from "../types/backend"
import { MessageAttachmentPart } from "../types/attachment"
import { Logger } from "../logging/logger"
import { systemPrompt, wrapText, pdfFragment, emitAssistantMessageEvent,
    resolveToolCalls, collectAttachmentPartsFromCalls,
    gatherMessageAttachmentParts, computeCmdAttachments, isAttachmentMime, 
    emitUserMessageEvent} from './common.ts'
import { inlineNotFinal, inlineReset, serializeInlineAttachment, type InlineAttachment } from "../types/inlineAttachment"

// Extract concatenated assistant text from a Gemini response.
export function geminiAssistantText(
    response: GenerateContentResponse
) : string {
    const first = response.candidates && response.candidates[0]
    const parts = first?.content?.parts || []
    return parts.map(p => p.text || "").join("")
}

function consolidateText(response : GenerateContentResponse) {
    const newParts : Part[] = []
    let curPart : Part = {}
    const first = response.candidates && response.candidates[0]
    if (first?.content?.parts?.length) {
        for (const part of first.content.parts) {
            if (part.text) {
                if (curPart.text) curPart.text += part.text
                else curPart = part
            } else {
                if (curPart.text) newParts.push(curPart)
                newParts.push(part)
                curPart = {}
            }
        }
        if (curPart.text) newParts.push(curPart)
        first.content.parts = newParts
    }
}

function initResponse() : GenerateContentResponse & { candidates: [Candidate,...Candidate[]] } {
      const response = new GenerateContentResponse()
      response.candidates = [{ content: { parts: [] } }]
      return response as GenerateContentResponse & { candidates: [Candidate,...Candidate[]] }
}

async function getResult(lectic: Lectic, client: GoogleGenAI, model : string, messages: ContentListUnion) {
    const nativeTools = (lectic.header.interlocutor.tools || [])
    .filter(tool => "native" in tool)
    .map(tool => tool.native)

    let thinkingConfig : Gemini.ThinkingConfig

    switch (lectic.header.interlocutor.thinking_effort) {
      case "low" : thinkingConfig = { includeThoughts: true, thinkingLevel: ThinkingLevel.LOW }; break
      case "medium" : thinkingConfig = { includeThoughts: true, thinkingLevel: ThinkingLevel.THINKING_LEVEL_UNSPECIFIED }; break
      case "high" : thinkingConfig = { includeThoughts: true, thinkingLevel: ThinkingLevel.HIGH }; break
      case "none" : thinkingConfig = { includeThoughts: true, thinkingBudget: 0 }; break
      default: thinkingConfig = { includeThoughts: true, thinkingBudget: lectic.header.interlocutor.thinking_budget ?? -1 }
    }

    return await client.models.generateContentStream({
        model: lectic.header.interlocutor.model ?? model,
        contents: messages,
        config: {
            systemInstruction: systemPrompt(lectic),
            tools: [{
                functionDeclarations: getTools(lectic),
                googleSearch: nativeTools.find(tool => tool === "search") 
                    ? {}
                    : undefined,
                codeExecution: nativeTools.find(tool => tool ==="code")
                    ? {}
                    : undefined
            },{
            }],
            temperature: lectic.header.interlocutor.temperature,
            maxOutputTokens: lectic.header.interlocutor.max_tokens,
            thinkingConfig
        }
    });
}

async function* accumulateStream(
    response : AsyncGenerator<GenerateContentResponse>, 
    accumulator : GenerateContentResponse & { candidates: [Candidate,...Candidate[]] }) : AsyncGenerator<string> {

      for await (const chunk of response) {
          const first = chunk.candidates && chunk.candidates[0]
          if (first?.content?.parts?.length &&
              accumulator.candidates[0].content?.parts
             ) {
              for (const part of first.content.parts) {
                  if (part.thought !== true && typeof part.text == "string") {
                      yield part.text
                  }
                  if (part.codeExecutionResult) {
                      yield "\n\n"
                  }
                  accumulator.candidates[0].content?.parts?.push(part)
              }
          }
          if (first?.finishReason) {
              accumulator.candidates[0].finishReason = first.finishReason 
          }
          accumulator.usageMetadata = chunk.usageMetadata ?? accumulator.usageMetadata
          accumulator.promptFeedback = chunk.promptFeedback ?? accumulator.promptFeedback
      }
          
      consolidateText(accumulator)
}

function getTools(lectic : Lectic) : Gemini.FunctionDeclaration[] {
    const tools : Gemini.FunctionDeclaration[] = []
    for (const tool of Object.values(lectic.header.interlocutor.registry ?? {})) {
        const properties = tool.parameters
        const required = tool.required ?? []
        // required by gemini <= 2.0
        const propertyOrdering = Object.keys(properties)
        const parametersJsonSchema = {
            type: "object",
            properties,
            required,
            additionalProperties: false,
            propertyOrdering,
        } as const
        tools.push({
            name: tool.name,
            description: tool.description,
            parametersJsonSchema,
        })
    }
    return tools
}


async function *runConversationLoop(
    opt: {
        messages: Content[]
        lectic: Lectic
        client: GoogleGenAI
        inlinePreface: InlineAttachment[]
    }
) : AsyncGenerator<string | Message> {

    const messages = opt.messages
    const lectic = opt.lectic
    const client = opt.client
    // model has been set at this point
    const model = lectic.header.interlocutor.model as string

    const registry = lectic.header.interlocutor.registry ?? {}
    const maxToolUse = lectic.header.interlocutor.max_tool_use ?? 10

    let loopCount = 0
    let finalPassCount = 0

    // Preface inline attachments at the top of the assistant block.
    if (opt.inlinePreface.length > 0) {
        const preface = opt.inlinePreface
            .map(serializeInlineAttachment)
            .join("\n\n") + "\n\n"
        yield preface
    }

    let pendingHookRes: InlineAttachment[] = []

    for (;;) {
        Logger.debug("gemini - messages", messages)

        const accumulatedResponse = initResponse()
        const result = await getResult(lectic, client, model, messages)
        yield* accumulateStream(result, accumulatedResponse)

        const hasToolCalls = (accumulatedResponse.functionCalls?.length ?? 0) > 0
        const usageMeta = accumulatedResponse.usageMetadata
        const usage = usageMeta ? {
            input: usageMeta.promptTokenCount ?? 0,
            cached: usageMeta.cachedContentTokenCount ?? 0,
            output: usageMeta.candidatesTokenCount ?? 0,
            total: usageMeta.totalTokenCount ?? 0
        } : undefined

        pendingHookRes = emitAssistantMessageEvent(
            geminiAssistantText(accumulatedResponse),
            lectic,
            { toolUseDone: !hasToolCalls, usage, loopCount, finalPassCount }
        )

        if (pendingHookRes.length > 0) {
            if (!hasToolCalls) finalPassCount++
            yield "\n\n"
            yield pendingHookRes.map(serializeInlineAttachment).join("\n\n")
            yield "\n\n"
        }

        const needsFollowUp =
            hasToolCalls || pendingHookRes.filter(inlineNotFinal).length > 0

        if (!needsFollowUp) return

        yield "\n\n"
        loopCount++

        if (loopCount > maxToolUse + 2) {
            yield "<error>Runaway tool use!</error>"
            return
        }

        const resetAttachments = pendingHookRes.filter(inlineReset)
        if (resetAttachments.length > 0) {
            messages.length = 0
            messages.push({
                role: "user",
                parts: resetAttachments.map(h => ({ text: h.content }))
            })
        }

        messages.push({
            role: "model",
            parts: accumulatedResponse.candidates?.[0].content?.parts
        })

        const calls = accumulatedResponse.functionCalls ?? []

        // Normalize missing id
        for (const call of calls) call.id = call.id ?? Bun.randomUUIDv7()

        // Resolve via shared helper
        const entries = calls.map(call => ({
            id: call.id,
            name: call.name ?? "",
            args: call.args,
        }))

        const realized = await resolveToolCalls(entries, registry, {
            limitExceeded: loopCount > maxToolUse,
            lectic,
            usage
        })

        // Convert to provider FunctionResponse parts
        const functionResponses : FunctionResponse[] = realized.map(call => ({
            id: call.id ?? "",
            name: call.name,
            response: call.isError
                ? { error: call.results.filter(r => !isAttachmentMime(r.mimetype)) }
                : { output: call.results.filter(r => !isAttachmentMime(r.mimetype)) }
        }))

        // Attach any non-text results by merging into the same user message
        const userParts: Part[] = [
            ...functionResponses.map(response => ({ functionResponse : response})),
            ...await collectAttachmentPartsFromCalls(realized, partToContent)
        ]

        for (const h of pendingHookRes.filter(h => !inlineReset(h))) {
            userParts.push({ text: h.content })
        }

        // yield results
        for (const call of realized) {
            const theTool = call.name in registry ? registry[call.name] : null
            yield serializeCall(theTool, {
                name: call.name,
                args: call.args,
                id: call.id,
                isError: call.isError,
                results: call.results
            }) + "\n\n"
        }

        messages.push({ role: "user", parts: userParts })

        // Loop continues with updated messages.
    }
}

async function partToContent(part : MessageAttachmentPart) 
    : Promise<Part | null> {
    const media_type = part.mimetype
    let bytes = part.bytes
    if (!(media_type && bytes)) return null
    // XXX seems like not all models support all mime types
    // cf https://ai.google.dev/gemini-api/docs/vision?hl=en&lang=node
    switch(media_type) {
        case "image/gif" : 
        case "image/jpeg": 
        case "image/webp": 
        case "image/heic": 
        case "image/heif": 
        case "image/png": 
        case "video/mp4":
        case "video/mpeg":
        case "video/mov":
        case "video/avi":
        case "video/x-flv":
        case "video/mpg":
        case "video/webm":
        case "video/wmv":
        case "video/3gpp":
        case "audio/wav":
        case "audio/mp3":
        case "audio/mpeg":
        case "audio/x-m4a":
        case "audio/aiff":
        case "audio/aac":
        case "audio/ogg":
        case "audio/flac":
        case "text/plain": return {
            inlineData : {
                mimeType: media_type,
                data: Buffer.from(bytes).toString("base64")
            }
        } as const
        case "application/pdf": {
            if (part.fragmentParams) bytes = await pdfFragment(bytes, part.fragmentParams)
            return {
                inlineData : {
                    mimeType: media_type,
                    data: Buffer.from(bytes).toString("base64")
                }
            } as const
        }
        default: {
            return {
                text: `<error>Media type ${media_type} is not supported.</error>` 
            }
        }
    }
}

async function handleMessage(
    msg : Message,
    lectic: Lectic,
    opt?: { inlineAttachments?: InlineAttachment[] }
) : Promise<{ messages: Content[], reset: boolean }> {
    if (msg.role === "assistant" && msg.name === lectic.header.interlocutor.name) {
        let results : Content[] = []
        let reset = false
        const { interactions } = msg.parseAssistantContent()
        for (const interaction of interactions) {
            if (interaction.attachments.some(inlineReset)) {
                results = []
                reset = true
            }
            if (interaction.attachments.length > 0) {
                results.push({ role: "user", parts: interaction.attachments.map(a => ({ text: a.content })) })
            }
            const modelParts : Part[] = []
            const userParts : Part[] = []
            if (interaction.text.length > 0) {
                modelParts.push({ text : interaction.text })
            }
            for (const call of interaction.calls) {
                modelParts.push({
                    functionCall: {
                        name: call.name,
                        args: call.args,
                        id: call.id
                    }
                })
            }

            results.push({ role: "model", parts: modelParts})

            if (interaction.calls.length > 0) {
                for (const call of interaction.calls) {
                    const resp = call.isError
                        ? { error: call.results.filter(r => !isAttachmentMime(r.mimetype)) }
                        : { output: call.results.filter(r => !isAttachmentMime(r.mimetype)) }
                    userParts.push({
                        functionResponse: {
                            name: call.name,
                            id: call.id,
                            response: resp
                        }
                    })
                }
                userParts.push(...await collectAttachmentPartsFromCalls(interaction.calls, partToContent))
                results.push({role : "user", parts: userParts})
            }
        }
        return { messages: results, reset }
    } else if (msg.role === "assistant") {
        return { messages: [{ 
            role : "user", 
            parts: [{ text: wrapText({text: msg.content, name: msg.name})}]
        }], reset: false }
    } else {
        const parts: MessageAttachmentPart[] = await gatherMessageAttachmentParts(msg)

        if (msg.content.length == 0) { msg.content = "…" }

        const content : Part[] = [{ text: msg.content }]

        for (const part of parts) {
            try {
                const source = await partToContent(part)
                if (source) content.push(source)
            } catch (e) {
                content.push({
                    text:`<error>` +
                        `Something went wrong while retrieving ${part.title} from ${part.URI}:${(e as Error).message}` +
                    `</error>`
                })
            }
        }

        if (opt?.inlineAttachments !== undefined) {
            const { textBlocks, inline } = await computeCmdAttachments(msg)
            for (const t of textBlocks) content.push({ text: t })
            for (const t of opt.inlineAttachments) content.push({ text: t.content })
            opt.inlineAttachments.push(...inline)
        }

        return { messages: [{ role : "user", parts: content }], reset: false }
    }
}

export const GeminiBackend : Backend & { client : GoogleGenAI} = {

    async listModels(): Promise<string[]> {
      try {
        const pager: Pager<Model> = await this.client.models.list()
        const ids: string[] = []
        for await (const m of pager) {
            if (m.name && m.supportedActions?.includes("generateContent")) {
                ids.push(m.name.match(/models\/(.*)/)?.[1] || m.name)
            }
        }
        return ids
      } catch (_e) {
        return []
      }
    },

    async *evaluate(lectic : Lectic) : AsyncIterable<string | Message> {

      const messages : Content[] = []

      // Execute :cmd only if the last message is a user message
      const lastIdx = lectic.body.messages.length - 1
      const lastIsUser = lastIdx >= 0 && lectic.body.messages[lastIdx].role === 'user'

      const inlineAttachments: InlineAttachment[] = []

      for (let i = 0; i < lectic.body.messages.length; i++) {
          const m = lectic.body.messages[i]
          if (m.role === "user" && lastIsUser && i === lastIdx) {
              inlineAttachments.push(...emitUserMessageEvent(m.content, lectic))
              const { messages: newMsgs } = await handleMessage(m, lectic, { inlineAttachments })
              messages.push(...newMsgs)
          } else {
              const { messages: newMsgs, reset } = await handleMessage(m, lectic)
              if (reset) messages.length = 0
              messages.push(...newMsgs)
          }
      }

      lectic.header.interlocutor.model =
          lectic.header.interlocutor.model ?? this.defaultModel

      yield* runConversationLoop({
          messages,
          lectic,
          client: this.client,
          inlinePreface: inlineAttachments,
      })

    },

    defaultModel : "gemini-2.5-flash",

    provider : LLMProvider.Gemini,

    client : new GoogleGenAI({apiKey : process.env['GEMINI_API_KEY'] || ""}), //XXX subverting type system.

}
