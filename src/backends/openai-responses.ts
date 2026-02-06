import OpenAI from "openai"
import type { Message } from "../types/message"
import type { HasModel, Lectic } from "../types/lectic"
import type { BackendCompletion, BackendUsage } from "../types/backend"
import { Backend } from "../types/backend"
import { type LLMProvider } from "../types/provider"
import { type MessageAttachmentPart } from "../types/attachment"
import { Logger } from "../logging/logger"
import {
  systemPrompt,
  wrapText,
  pdfFragment,
  collectAttachmentPartsFromCalls,
  gatherMessageAttachmentParts,
  isAttachmentMime,
  destrictifyToolResults,
} from "./common.ts"
import { inlineReset, type InlineAttachment } from "../types/inlineAttachment"
import type { ToolCall } from "../types/tool"
import type { ToolCallEntry, ToolRegistry } from "../types/backend"
import { strictify } from "../types/schema.ts"

const SUPPORTS_PROMPT_CACHE_RETENTION = [
  "gpt-5.2",
  "gpt-5.1",
  "gpt-5.1-codex",
  "gpt-5.1-codex-mini",
  "gpt-5.1-codex-max",
  "gpt-5.1-chat-latest",
  "gpt-5",
  "gpt-5-codex",
  "gpt-4.1",
]

function getTools(lectic: Lectic): OpenAI.Responses.Tool[] {
  const tools: OpenAI.Responses.Tool[] = []

  const nativeTools = (lectic.header.interlocutor.tools || [])
    .filter((tool) => "native" in tool)
    .map((tool) => tool.native)

  for (const tool of Object.values(lectic.header.interlocutor.registry ?? {})) {
    tools.push({
      type: "function",
      name: tool.name,
      description: tool.description,
      strict: true,
      parameters: strictify({
        type: "object",
        properties: tool.parameters,
        required: tool.required,
      }),
    })
  }

  if (nativeTools.find((tool) => tool === "search")) {
    tools.push({ type: "web_search_preview" })
  }

  if (nativeTools.find((tool) => tool === "code")) {
    tools.push({ type: "code_interpreter", container: { type: "auto" } })
  }

  return tools
}

async function partToContent(
  part: MessageAttachmentPart
): Promise<OpenAI.Responses.ResponseInputContent | null> {
  const media_type = part.mimetype
  let bytes = part.bytes
  if (!(media_type && bytes)) return null

  switch (media_type) {
    case "image/gif":
    case "image/jpeg":
    case "image/webp":
    case "image/png":
      return {
        type: "input_image",
        image_url:
          `data:${media_type};base64,${Buffer.from(bytes).toString("base64")}`,
        detail: "auto",
      } as const

    case "audio/mp3":
    case "audio/mpeg":
    case "application/pdf":
      if (part.fragmentParams) {
        bytes = await pdfFragment(bytes, part.fragmentParams)
      }
      return {
        type: "input_file",
        filename: part.title,
        file_data:
          `data:${media_type};base64,${Buffer.from(bytes).toString("base64")}`,
      } as const

    case "text/plain":
      return {
        type: "input_text",
        text: `<file title="${part.title}">${Buffer.from(bytes).toString()}</file>`,
      } as const

    default:
      return {
        type: "input_text",
        text: `<error>Media type ${media_type} is not supported.</error>`,
      }
  }
}

export class OpenAIResponsesBackend extends Backend<
  OpenAI.Responses.ResponseInputItem,
  OpenAI.Responses.Response
> {
  provider: LLMProvider
  defaultModel: string
  apiKey: string
  url?: string
  cache_retention: boolean = true

  constructor(opt: {
    apiKey: string
    provider: LLMProvider
    url?: string
    defaultModel: string
  }) {
    super()
    this.provider = opt.provider
    this.apiKey = opt.apiKey
    this.defaultModel = opt.defaultModel
    this.url = opt.url
  }

  async listModels(): Promise<string[]> {
    try {
      const ids: string[] = []
      const page = await this.client.models.list()
      for await (const m of page) ids.push(m.id)
      return ids
    } catch (_e) {
      return []
    }
  }

  protected async handleMessage(
    msg: Message,
    lectic: Lectic,
    opt?: { inlineAttachments?: InlineAttachment[] }
  ) {
    if (msg.role === "assistant" && msg.name === lectic.header.interlocutor.name) {
      const results: OpenAI.Responses.ResponseInput = []
      let reset = false

      const { interactions } = msg.parseAssistantContent()
      for (const interaction of interactions) {
        if (interaction.attachments.some(inlineReset)) {
          results.length = 0
          reset = true
        }

        if (interaction.attachments.length > 0) {
          results.push({
            role: "user",
            content: interaction.attachments.map((a) => ({
              type: "input_text" as const,
              text: a.content,
            })),
          })
        }

        if (interaction.text) {
          results.push({ role: "assistant", content: interaction.text })
        }

        const callsWithIds = interaction.calls.map((call) => ({
          id: call.id ?? Bun.randomUUIDv7(),
          call,
        }))

        for (const { id, call } of callsWithIds) {
          results.push({
            type: "function_call",
            call_id: id,
            name: call.name,
            arguments: JSON.stringify(call.args),
          })
        }

        if (interaction.calls.length > 0) {
          const attachParts = await collectAttachmentPartsFromCalls(
            interaction.calls,
            partToContent
          )
          if (attachParts.length > 0) {
            results.push({ role: "user", content: attachParts })
          }
        }

        for (const { id, call } of callsWithIds) {
          results.push({
            type: "function_call_output",
            call_id: id,
            output: JSON.stringify(call.results.filter((r) => !isAttachmentMime(r.mimetype))),
          })
        }
      }

      return { messages: results, reset }
    }

    if (msg.role === "assistant") {
      const messages : OpenAI.Responses.ResponseInput = [
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: wrapText({
                text: msg.content || "…",
                name: msg.name,
              }),
            },
          ],
        },
      ]
      return { messages, reset: false }
    }

    const parts: MessageAttachmentPart[] = await gatherMessageAttachmentParts(msg)

    const content: OpenAI.Responses.ResponseInputMessageContentList = [
      { type: "input_text", text: msg.content },
    ]

    for (const part of parts) {
      try {
        const source = await partToContent(part)
        if (source) content.push(source)
      } catch (e) {
        const err = e instanceof Error ? e.message : String(e)
        content.push({
          type: "input_text",
          text:
            `<error>Something went wrong while retrieving ${part.title} ` +
            `from ${part.URI}:${err}</error>`,
        })
      }
    }

    if (opt?.inlineAttachments !== undefined) {
      for (const t of opt.inlineAttachments) {
        content.push({ type: "input_text", text: t.content })
      }
    }
    const messages : OpenAI.Responses.ResponseInput = [{ role: msg.role, content }]
    return { messages, reset: false }
  }

  protected async createCompletion(opt: {
    messages: OpenAI.Responses.ResponseInputItem[]
    lectic: Lectic & HasModel
  }): Promise<BackendCompletion<OpenAI.Responses.Response>> {
    const { messages, lectic } = opt

    const model = lectic.header.interlocutor.model

    const output_schema = lectic.header.interlocutor.output_schema
    const textConfig = output_schema
      ? {
          format: {
            type: "json_schema" as const,
            name: "output",
            strict: true,
            schema: strictify(output_schema),
          },
        }
      : undefined

    Logger.debug("openai - messages", messages)

    const stream = this.client.responses.stream({
      instructions: systemPrompt(lectic),
      input: messages,
      model,
      include: ["reasoning.encrypted_content", "code_interpreter_call.outputs"],
      prompt_cache_retention: this.cache_retention && SUPPORTS_PROMPT_CACHE_RETENTION.includes(model)
        ? "24h"
        : undefined,
      temperature: lectic.header.interlocutor.temperature,
      max_output_tokens: lectic.header.interlocutor.max_tokens,
      reasoning: lectic.header.interlocutor.thinking_effort
        ? { effort: lectic.header.interlocutor.thinking_effort }
        : undefined,
      tools: getTools(lectic),
      text: textConfig,
      store: false,
    })

    async function* text(): AsyncGenerator<string> {
      for await (const event of stream) {
        if (event.type === "response.output_text.delta") {
          yield event.delta || ""
        }
      }
    }

    return {
      text: text(),
      final: stream.finalResponse(),
    }
  }

  protected finalHasToolCalls(final: OpenAI.Responses.Response): boolean {
    return final.output.some((o) => o.type === "function_call")
  }

  protected finalUsage(final: OpenAI.Responses.Response): BackendUsage | undefined {
    const usageData = final.usage
    if (!usageData) return undefined

    return {
      input: usageData.input_tokens,
      cached: usageData.input_tokens_details.cached_tokens ?? 0,
      output: usageData.output_tokens,
      total: usageData.total_tokens,
    }
  }

  protected applyReset(
    messages: OpenAI.Responses.ResponseInputItem[],
    resetAttachments: InlineAttachment[],
  ) {
    messages.length = 0
    messages.push({
      role: "user",
      content: resetAttachments.map((h) => ({
        type: "input_text",
        text: h.content,
      })),
    })
  }

  protected appendAssistantMessage(
    messages: OpenAI.Responses.ResponseInputItem[],
    final: OpenAI.Responses.Response,
    _lectic: Lectic
  ) {
    for (const output of final.output) {
      if (output.type === "function_call" && "parsed_arguments" in output) {
        delete output.parsed_arguments
      }
    }

    for (const o of final.output) {
      if (o.type === "apply_patch_call_output" || o.type === "apply_patch_call") {
        continue
      }
      messages.push(o)
    }
  }

  protected getToolCallEntries(
    final: OpenAI.Responses.Response,
    registry: ToolRegistry
  ): ToolCallEntry[] {
    return final.output
      .filter((o) => o.type === "function_call")
      .map((o) => {
        const tool = registry[o.name] ?? null
        const args = destrictifyToolResults(tool, o.arguments)
        return { id: o.call_id, name: o.name, args }
      })
  }

  protected async appendToolResults(opt: {
    messages: OpenAI.Responses.ResponseInputItem[]
    final: OpenAI.Responses.Response
    realized: ToolCall[]
    hookAttachments: InlineAttachment[]
    lectic: Lectic
  }): Promise<void> {
    const { messages, realized, hookAttachments } = opt

    const attachParts = await collectAttachmentPartsFromCalls(realized, partToContent)

    for (const h of hookAttachments) {
      attachParts.push({ type: "input_text", text: h.content })
    }

    if (attachParts.length > 0) {
      messages.push({ role: "user", content: attachParts })
    }

    for (const call of realized) {
      messages.push({
        type: "function_call_output",
        call_id: call.id ?? "undefined",
        output: JSON.stringify(call.results.filter((r) => !isAttachmentMime(r.mimetype))),
      })
    }
  }

  get client() {
    return new OpenAI({
      apiKey: process.env[this.apiKey] || "",
      baseURL: this.url,
    })
  }
}
