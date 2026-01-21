import type { Candidate, Content, ContentListUnion, Model, Pager, Part } from "@google/genai"
import type * as Gemini from "@google/genai"
import {
  type FunctionResponse,
  GenerateContentResponse,
  GoogleGenAI,
  ThinkingLevel,
  type FunctionCall,
} from "@google/genai"
import type { Message } from "../types/message"
import type { HasModel, Lectic } from "../types/lectic"
import type { BackendCompletion, BackendUsage, } from "../types/backend"
import { Backend } from "../types/backend"
import { LLMProvider } from "../types/provider"
import { type MessageAttachmentPart } from "../types/attachment"
import { Logger } from "../logging/logger"
import {
  systemPrompt,
  wrapText,
  pdfFragment,
  collectAttachmentPartsFromCalls,
  gatherMessageAttachmentParts,
  isAttachmentMime,
} from "./common.ts"
import { inlineReset, type InlineAttachment, } from "../types/inlineAttachment"
import type { ToolCall } from "../types/tool"
import type { ToolCallEntry, ToolRegistry } from "../types/backend"

type GeminiFinal = {
  response: GenerateContentResponse
  functionCalls: FunctionCall[]
}

// Extract concatenated assistant text from a Gemini response.
export function geminiAssistantText(response: GenerateContentResponse): string {
  const first = response.candidates?.[0]
  const parts = first?.content?.parts || []
  return parts.map((p) => p.text || "").join("")
}

function ensureCandidate0(resp: GenerateContentResponse): Candidate {
  const fresh: Candidate = {
    content: { role: "model", parts: [] },
  }

  if (!resp.candidates || resp.candidates.length === 0) {
    resp.candidates = [fresh]
    return fresh
  }

  const first = resp.candidates[0]
  if (!first.content) first.content = { role: "model", parts: [] }
  if (!first.content.parts) first.content.parts = []
  return first
}

function consolidateText(response: GenerateContentResponse) {
  const first = response.candidates?.[0]
  const parts = first?.content?.parts
  if (!first || !first.content || !parts) return

  const newParts: Part[] = []
  let cur: Part = {}

  for (const part of parts) {
    if (part.text) {
      if (cur.text) cur.text += part.text
      else cur = part
    } else {
      if (cur.text) newParts.push(cur)
      newParts.push(part)
      cur = {}
    }
  }

  if (cur.text) newParts.push(cur)
  first.content.parts = newParts
}

async function getResult(
  lectic: Lectic,
  client: GoogleGenAI,
  model: string,
  messages: ContentListUnion
) {
  const nativeTools = (lectic.header.interlocutor.tools || [])
    .filter((tool) => "native" in tool)
    .map((tool) => tool.native)

  let thinkingConfig: Gemini.ThinkingConfig

  switch (lectic.header.interlocutor.thinking_effort) {
    case "low":
      thinkingConfig = {
        includeThoughts: true,
        thinkingLevel: ThinkingLevel.LOW,
      }
      break
    case "medium":
      thinkingConfig = {
        includeThoughts: true,
        thinkingLevel: ThinkingLevel.THINKING_LEVEL_UNSPECIFIED,
      }
      break
    case "high":
      thinkingConfig = {
        includeThoughts: true,
        thinkingLevel: ThinkingLevel.HIGH,
      }
      break
    case "none":
      thinkingConfig = { includeThoughts: true, thinkingBudget: 0 }
      break
    default:
      thinkingConfig = {
        includeThoughts: true,
        thinkingBudget: lectic.header.interlocutor.thinking_budget ?? -1,
      }
  }

  return client.models.generateContentStream({
    model: lectic.header.interlocutor.model ?? model,
    contents: messages,
    config: {
      systemInstruction: systemPrompt(lectic),
      tools: [
        {
          functionDeclarations: getTools(lectic),
          googleSearch: nativeTools.find((tool) => tool === "search")
            ? {}
            : undefined,
          codeExecution: nativeTools.find((tool) => tool === "code")
            ? {}
            : undefined,
        },
        {},
      ],
      temperature: lectic.header.interlocutor.temperature,
      maxOutputTokens: lectic.header.interlocutor.max_tokens,
      thinkingConfig,
    },
  })
}

async function* accumulateStream(opt: {
  response: AsyncGenerator<GenerateContentResponse>
  accumulator: GenerateContentResponse
  functionCalls: FunctionCall[]
}): AsyncGenerator<string> {
  const accFirst = ensureCandidate0(opt.accumulator)
  const accParts = accFirst.content?.parts
  if (!accParts) throw new Error("Gemini accumulator missing parts")

  for await (const chunk of opt.response) {
    const first = chunk.candidates?.[0]
    const parts = first?.content?.parts

    if (parts && parts.length > 0) {
      for (const part of parts) {
        if (part.thought !== true && typeof part.text === "string") {
          yield part.text
        }
        if (part.codeExecutionResult) {
          yield "\n\n"
        }
        accParts.push(part)
      }
    }

    if (first?.finishReason) {
      ensureCandidate0(opt.accumulator).finishReason = first.finishReason
    }

    opt.accumulator.usageMetadata =
      chunk.usageMetadata ?? opt.accumulator.usageMetadata
    opt.accumulator.promptFeedback =
      chunk.promptFeedback ?? opt.accumulator.promptFeedback

    if (chunk.functionCalls && chunk.functionCalls.length > 0) {
      opt.functionCalls.push(...chunk.functionCalls)
    }
  }

  consolidateText(opt.accumulator)
}

function getTools(lectic: Lectic): Gemini.FunctionDeclaration[] {
  const tools: Gemini.FunctionDeclaration[] = []

  for (const tool of Object.values(lectic.header.interlocutor.registry ?? {})) {
    const properties = tool.parameters
    const required = tool.required ?? []
    const propertyOrdering = Object.keys(properties)

    tools.push({
      name: tool.name,
      description: tool.description,
      parametersJsonSchema: {
        type: "object",
        properties,
        required,
        additionalProperties: false,
        propertyOrdering,
      },
    })
  }

  return tools
}

async function partToContent(part: MessageAttachmentPart): Promise<Part | null> {
  const media_type = part.mimetype
  let bytes = part.bytes
  if (!(media_type && bytes)) return null

  switch (media_type) {
    case "image/gif":
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
    case "text/plain":
      return {
        inlineData: {
          mimeType: media_type,
          data: Buffer.from(bytes).toString("base64"),
        },
      } as const

    case "application/pdf":
      if (part.fragmentParams) {
        bytes = await pdfFragment(bytes, part.fragmentParams)
      }
      return {
        inlineData: {
          mimeType: media_type,
          data: Buffer.from(bytes).toString("base64"),
        },
      } as const

    default:
      return {
        text: `<error>Media type ${media_type} is not supported.</error>`,
      }
  }
}

export class GeminiBackend extends Backend<Content, GeminiFinal> {
  provider = LLMProvider.Gemini
  defaultModel = "gemini-2.5-flash"
  client: GoogleGenAI

  constructor() {
    super()
    this.client = new GoogleGenAI({ apiKey: process.env["GEMINI_API_KEY"] || "" })
  }

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
    } catch {
      return []
    }
  }

  protected async handleMessage(
    msg: Message,
    lectic: Lectic,
    opt?: { inlineAttachments?: InlineAttachment[] }
  ) {
    if (msg.role === "assistant" && msg.name === lectic.header.interlocutor.name) {
      let results: Content[] = []
      let reset = false

      const { interactions } = msg.parseAssistantContent()
      for (const interaction of interactions) {
        if (interaction.attachments.some(inlineReset)) {
          results = []
          reset = true
        }

        if (interaction.attachments.length > 0) {
          results.push({
            role: "user",
            parts: interaction.attachments.map((a) => ({ text: a.content })),
          })
        }

        const modelParts: Part[] = []
        const userParts: Part[] = []

        if (interaction.text.length > 0) {
          modelParts.push({ text: interaction.text })
        }

        for (const call of interaction.calls) {
          modelParts.push({
            functionCall: {
              name: call.name,
              args: call.args,
              id: call.id,
            },
          })
        }

        results.push({ role: "model", parts: modelParts })

        if (interaction.calls.length > 0) {
          for (const call of interaction.calls) {
            const resp = call.isError
              ? { error: call.results.filter((r) => !isAttachmentMime(r.mimetype)) }
              : { output: call.results.filter((r) => !isAttachmentMime(r.mimetype)) }

            userParts.push({
              functionResponse: {
                name: call.name,
                id: call.id,
                response: resp,
              },
            })
          }

          userParts.push(
            ...await collectAttachmentPartsFromCalls(interaction.calls, partToContent)
          )

          results.push({ role: "user", parts: userParts })
        }
      }

      return { messages: results, reset }
    }

    if (msg.role === "assistant") {
      return {
        messages: [
          {
            role: "user",
            parts: [{ text: wrapText({ text: msg.content, name: msg.name }) }],
          },
        ],
        reset: false,
      }
    }

    const parts: MessageAttachmentPart[] = await gatherMessageAttachmentParts(msg)

    if (msg.content.length === 0) msg.content = "…"

    const content: Part[] = [{ text: msg.content }]

    for (const part of parts) {
      try {
        const source = await partToContent(part)
        if (source) content.push(source)
      } catch (e) {
        const err = e instanceof Error ? e.message : String(e)
        content.push({
          text:
            `<error>` +
            `Something went wrong while retrieving ${part.title} from ` +
            `${part.URI}:${err}` +
            `</error>`,
        })
      }
    }

    if (opt?.inlineAttachments !== undefined) {
      for (const t of opt.inlineAttachments) {
        content.push({ text: t.content })
      }
    }

    return { messages: [{ role: "user", parts: content }], reset: false }
  }

  protected async createCompletion(opt: {
    messages: Content[]
    lectic: Lectic & HasModel
  }): Promise<BackendCompletion<GeminiFinal>> {
    const { messages, lectic } = opt

    const model = lectic.header.interlocutor.model

    Logger.debug("gemini - messages", messages)

    const accumulatedResponse = new GenerateContentResponse()
    ensureCandidate0(accumulatedResponse)

    const functionCalls: FunctionCall[] = []
    const response = await getResult(lectic, this.client, model, messages)

    let resolveFinal: (final: GeminiFinal) => void = () => {}
    const final = new Promise<GeminiFinal>((resolve) => {
      resolveFinal = resolve
    })

    async function* text(): AsyncGenerator<string> {
      for await (const chunk of accumulateStream({
        response,
        accumulator: accumulatedResponse,
        functionCalls,
      })) {
        yield chunk
      }
      resolveFinal({ response: accumulatedResponse, functionCalls })
    }

    return { text: text(), final }
  }

  protected finalHasToolCalls(final: GeminiFinal): boolean {
    return final.functionCalls.length > 0
  }

  protected finalUsage(final: GeminiFinal): BackendUsage | undefined {
    const usageMeta = final.response.usageMetadata
    if (!usageMeta) return undefined

    return {
      input: usageMeta.promptTokenCount ?? 0,
      cached: usageMeta.cachedContentTokenCount ?? 0,
      output: usageMeta.candidatesTokenCount ?? 0,
      total: usageMeta.totalTokenCount ?? 0,
    }
  }

  protected applyReset(
    messages: Content[],
    resetAttachments: InlineAttachment[],
  ) {
    messages.length = 0
    messages.push({
      role: "user",
      parts: resetAttachments.map((h) => ({ text: h.content })),
    })
  }

  protected appendAssistantMessage(
    messages: Content[],
    final: GeminiFinal,
    _lectic: Lectic
  ) {
    messages.push({
      role: "model",
      parts: final.response.candidates?.[0].content?.parts ?? [],
    })
  }

  protected getToolCallEntries(
    final: GeminiFinal,
    _registry: ToolRegistry
  ): ToolCallEntry[] {
    return final.functionCalls.map((call) => ({
      id: call.id ?? Bun.randomUUIDv7(),
      name: call.name ?? "",
      args: call.args,
    }))
  }

  protected async appendToolResults(opt: {
    messages: Content[]
    final: GeminiFinal
    realized: ToolCall[]
    hookAttachments: InlineAttachment[]
    lectic: Lectic
  }): Promise<void> {
    const { messages, realized, hookAttachments } = opt

    const functionResponses: FunctionResponse[] = realized.map((call) => ({
      id: call.id ?? "",
      name: call.name,
      response: call.isError
        ? { error: call.results.filter((r) => !isAttachmentMime(r.mimetype)) }
        : { output: call.results.filter((r) => !isAttachmentMime(r.mimetype)) },
    }))

    const userParts: Part[] = [
      ...functionResponses.map((response) => ({ functionResponse: response })),
      ...await collectAttachmentPartsFromCalls(realized, partToContent),
    ]

    for (const h of hookAttachments) {
      userParts.push({ text: h.content })
    }

    messages.push({ role: "user", parts: userParts })
  }
}
