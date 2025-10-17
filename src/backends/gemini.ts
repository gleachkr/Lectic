import type { Content, Part, Schema, ContentListUnion, Candidate, Model, Pager } from '@google/genai'
import type * as Gemini from '@google/genai' 
import { GoogleGenAI, Type, GenerateContentResponse } from '@google/genai'
import type { Message } from "../types/message"
import type { Lectic } from "../types/lectic"
import type { JSONSchema } from "../types/schema"
import { serializeCall, ToolCallResults, type ToolCallResult } from "../types/tool"
import { LLMProvider } from "../types/provider"
import type { Backend } from "../types/backend"
import { MessageAttachment, MessageAttachmentPart } from "../types/attachment"
import { MessageCommand } from "../types/directive.ts"
import { Logger } from "../logging/logger"
import { systemPrompt, wrapText, pdfFragment, emitAssistantMessageEvent } from './common.ts'

// Extract concatenated assistant text from a Gemini response.
export function geminiAssistantText(
    response: GenerateContentResponse
) : string {
    const parts = response.candidates?.[0]?.content?.parts || []
    return parts.map(p => (p as any).text || "").join("")
}

type FunctionResponse = Part & { 
    functionResponse : { 
        id: string, 
        name: string, 
        response: {output: ToolCallResult[], error?: ToolCallResult[] } | 
                  {error : ToolCallResult[], output?: ToolCallResult[]} 
    } 
}

function googleParameter(param: JSONSchema ) : Schema | undefined {
    switch (param.type) {
        case "string" : return { type: Type.STRING }
        case "number" : return { type: Type.NUMBER }
        case "integer" : return { type: Type.INTEGER }
        case "null" : return { type: Type.NULL }
        case "boolean" : return { type: Type.BOOLEAN }
        case "array" : return { 
            type: Type.ARRAY,
            items: googleParameter(param.items) ?? { type: Type.STRING }
        }
        case "object" : return { 
            type: Type.OBJECT,
            properties: googleParameters(param.properties)
        }
    }
}

function consolidateText(response : GenerateContentResponse) {
    const newParts : Part[] = []
    let curPart : Part = {}
    if (response.candidates?.[0].content?.parts?.length) {
        for (const part of response.candidates?.[0].content?.parts) {
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
        response.candidates[0].content.parts = newParts
    }
}

function initResponse() : GenerateContentResponse & { candidates: [Candidate,...Candidate[]] } {
      const response = new GenerateContentResponse()
      response.candidates = [{ content: { parts: [] } }]
      return response as GenerateContentResponse & { candidates: [Candidate,...Candidate[]] }
}

async function getResult(lectic: Lectic, client: GoogleGenAI, messages: ContentListUnion) {
    const nativeTools = (lectic.header.interlocutor.tools || [])
    .filter(tool => "native" in tool)
    .map(tool => tool.native)

    return await client.models.generateContentStream({
        model: lectic.header.interlocutor.model || "gemini-2.5-flash",
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
        }
    });
}

async function* accumulateStream(
    response : AsyncGenerator<GenerateContentResponse>, 
    accumulator : GenerateContentResponse & { candidates: [Candidate,...Candidate[]] }) : AsyncGenerator<string> {

      for await (const chunk of response) {
          if (chunk.candidates?.[0].content?.parts?.length &&
              accumulator.candidates[0]?.content?.parts
             ) {
              for (const part of chunk.candidates[0].content?.parts) {
                  if (typeof part.text == "string") {
                      yield part.text
                  }
                  if (part.codeExecutionResult) {
                      yield "\n\n"
                  }
                  accumulator.candidates[0]?.content?.parts.push(part)
              }
          }
          if (chunk.candidates?.[0]?.finishReason) {
              accumulator.candidates[0].finishReason = chunk.candidates[0].finishReason 
          }
          accumulator.usageMetadata = chunk.usageMetadata ?? accumulator.usageMetadata
          accumulator.promptFeedback = chunk.promptFeedback ?? accumulator.promptFeedback
      }
          
      consolidateText(accumulator)
}

function googleParameters(params: Record<string, JSONSchema>) : Record<string, Schema> {
    const rslt : Record<string, Schema> = {}
    for (const key of Object.keys(params)) {
        const param = googleParameter(params[key])
        if (!param) throw Error(`Google parameter coercion failed for parameter ${JSON.stringify(params[key])}`)
        rslt[key] = param
    }
    return rslt
}

function getTools(lectic : Lectic) : Gemini.FunctionDeclaration[] {
    const tools : Gemini.FunctionDeclaration[] = []
    for (const tool of Object.values(lectic.header.interlocutor.registry ?? {})) {
        tools.push( {
            name : tool.name,
            description : tool.description,
            parameters: {
                "type" : Type.OBJECT,
                "properties" : googleParameters(tool.parameters),
                "required" : tool.required ?? [],
            }
        })
    }
    return tools
}

async function *handleToolUse(
    response : GenerateContentResponse, 
    messages : Content[], 
    lectic : Lectic,
    client : GoogleGenAI) : AsyncGenerator<string | Message> {

    let recur = 0
    const registry = lectic.header.interlocutor.registry ?? {}
    const max_tool_use = lectic.header.interlocutor.max_tool_use ?? 10

    while (response.functionCalls && response.functionCalls.length > 0) {
        let calls = response.functionCalls
        yield "\n\n"
        recur++

        if (recur > max_tool_use + 2) {
            yield "<error>Runaway tool use!</error>"
            return
        }

        messages.push({
            role: "model",
            parts: response.candidates?.[0].content?.parts
        })

        const results : Promise<FunctionResponse>[] = calls.map(async call => {
            const name = call.name ?? "Name is required, should never occur"
            call.id = call.id ?? Bun.randomUUIDv7()
            const id = call.id
            if (recur > max_tool_use) {
                return {
                    functionResponse: { name, id,
                        response: { 
                            error: ToolCallResults(
                                "Tool usage limit exceeded, no further tool calls will be allowed"
                        )}}}
            } else if (call.name && call.name in registry) {
                return registry[call.name].call(call.args)
                    .then(results => ({
                        functionResponse: { name, id,
                            response: { output: results }
                    }})).catch((error : unknown) => ({
                        functionResponse: { name, id,
                            response: { error: error instanceof Error
                                ? ToolCallResults(error.message)
                                : ToolCallResults(`An error of unknown type occurred during a call to ${name}`),
                            }
                    }}))
            } else {
                return {
                    functionResponse: { name, id,
                        response: { error: ToolCallResults(`Unrecognized tool name: ${name}`),
                    }}
                }
            }

        })

        // run tool calls in parallel
        const parts = await Promise.all(results)

        // yield results
        for (const part of parts) {
            const call = calls.find(call => call.id === part.functionResponse.id)
            const name = part.functionResponse.name
            if (call && call.args instanceof Object) {
                 const theTool = name in registry ? registry[name] : null
                 yield serializeCall(theTool, {
                     name: name,
                     args: call.args, 
                     id: call.id,
                     isError : "error" in part.functionResponse.response,
                     results : part.functionResponse.response.output 
                         ?? part.functionResponse.response.error 
                         ?? [] // to make the typechecker happy
                 }) + "\n\n"
            }
        }

        messages.push({ role: "user", parts })

        Logger.debug("gemini - messages (tool)", messages)

        const accumulatedResponse = initResponse()

        const result = await getResult(lectic, client, messages)

        yield* accumulateStream(result, accumulatedResponse)

        emitAssistantMessageEvent(geminiAssistantText(accumulatedResponse), lectic.header.interlocutor.name)

        Logger.debug("gemini - reply (tool)", {
            accumulatedResponse
        })

        response = accumulatedResponse

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

async function handleMessage(msg : Message, lectic: Lectic) : Promise<Content[]> {
    if (msg.role === "assistant" && msg.name === lectic.header.interlocutor.name) {
        const results : Content[] = []
        for (const interaction of msg.containedInteractions()) {
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
                    userParts.push({
                        functionResponse: {
                            name: call.name,
                            id: call.id,
                            response: { output: call.results }
                        }
                    })
                }
                results.push({role : "user", parts: userParts})
            }
        }
        return results
    } else if (msg.role === "assistant") {
        return [{ 
            role : "user", 
            parts: [{ text: wrapText({text: msg.content, name: msg.name})}]
        }]
    } else {
        const links = msg.containedLinks().flatMap(MessageAttachment.fromGlob)
        const parts : MessageAttachmentPart[] = []
        for await (const link of links) {
            if (await link.exists()) {
                parts.push(... await link.getParts())
            }
        }
        const commands = msg.containedDirectives().map(d => new MessageCommand(d))

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

        for (const command of commands) {
            const result = await command.execute()
            if (result) {
                content.push({
                    text: result,
                })
            }
        }

        return [{ role : "user", parts: content }]
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

      for (const msg of lectic.body.messages) {
          messages.push(...await handleMessage(msg, lectic))
      }

      Logger.debug("gemini - messages", messages)

      const result = await getResult(lectic, this.client, messages)

      const accumulatedResponse = initResponse()

      yield* accumulateStream(result, accumulatedResponse)

      emitAssistantMessageEvent(geminiAssistantText(accumulatedResponse), lectic.header.interlocutor.name)

      if (accumulatedResponse.functionCalls?.length) {
          Logger.debug("gemini - reply (tool)", { accumulatedResponse })
          yield* handleToolUse(accumulatedResponse, messages, lectic, this.client);
      } else {
          Logger.debug("gemini - reply", { accumulatedResponse })
      }

    },

    provider : LLMProvider.Gemini,

    client : new GoogleGenAI({apiKey : process.env['GEMINI_API_KEY'] || ""}), //XXX subverting type system.

}
