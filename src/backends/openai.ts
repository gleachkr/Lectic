import OpenAI from "openai"
import type { Message } from "../types/message"
import type { Lectic } from "../types/lectic"
import type { BackendCompletion, BackendUsage } from "../types/backend"
import { Backend } from "../types/backend"
import { LLMProvider } from "../types/provider"
import { MessageAttachmentPart } from "../types/attachment"
import { Logger } from "../logging/logger"
import {
  systemPrompt,
  pdfFragment,
  collectAttachmentPartsFromCalls,
  gatherMessageAttachmentParts,
  computeCmdAttachments,
  isAttachmentMime,
  destrictifyToolResults,
} from "./common.ts"
import { inlineReset, type InlineAttachment } from "../types/inlineAttachment"
import type { ToolCall, ToolCallResult } from "../types/tool"
import type { ToolCallEntry, ToolRegistry } from "../types/backend"
import { strictify } from "../types/schema.ts"

const SUPPORTS_PROMPT_CACHE_RETENTION = [
  "gpt-5.1",
  "gpt-5.1-codex",
  "gpt-5.1-codex-mini",
  "gpt-5.1-chat-latest",
  "gpt-5",
  "gpt-4.1",
]

function getTools(lectic: Lectic): OpenAI.Chat.Completions.ChatCompletionTool[] {
  const tools: OpenAI.Chat.Completions.ChatCompletionTool[] = []

  for (const tool of Object.values(lectic.header.interlocutor.registry ?? {})) {
    tools.push({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description,
        strict: true,
        parameters: strictify({
          type: "object",
          properties: tool.parameters,
          required: tool.required,
        }),
      },
    })
  }

  return tools
}

async function partToContent(
  part: MessageAttachmentPart
): Promise<OpenAI.Chat.Completions.ChatCompletionContentPart | null> {
  const media_type = part.mimetype
  let bytes = part.bytes
  if (!(media_type && bytes)) return null

  switch (media_type) {
    case "image/gif":
    case "image/jpeg":
    case "image/webp":
    case "image/png":
      return {
        type: "image_url",
        image_url: {
          url: `data:${media_type};base64,${Buffer.from(bytes).toString("base64")}`,
        },
      } as const

    case "audio/mp3":
    case "audio/mpeg":
    case "audio/wav":
      return {
        type: "input_audio",
        input_audio: {
          data: Buffer.from(bytes).toString("base64"),
          format: media_type === "audio/wav" ? "wav" : "mp3",
        },
      }

    case "application/pdf":
      if (part.fragmentParams) {
        bytes = await pdfFragment(bytes, part.fragmentParams)
      }
      return {
        type: "file",
        file: {
          filename: part.title,
          file_data:
            `data:${media_type};base64,${Buffer.from(bytes).toString("base64")}`,
        },
      } as const

    case "text/plain":
      return {
        type: "text",
        text: `<file title="${part.title}">${Buffer.from(bytes).toString()}</file>`,
      } as const

    default:
      return {
        type: "text",
        text: `<error>Media type ${media_type} is not supported.</error>`,
      }
  }
}

function developerMessage(lectic: Lectic) {
  return {
    // OpenAI has moved to "developer" for this role, but so far they're
    // keeping backwards compatibility. Ollama however requires "system".
    role: "system" as const,
    content: systemPrompt(lectic),
  }
}

export class OpenAIBackend extends Backend<
  OpenAI.Chat.Completions.ChatCompletionMessageParam,
  OpenAI.Chat.Completions.ChatCompletion
> {
  provider: LLMProvider
  defaultModel: string
  apiKey: string
  url?: string

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
    } catch {
      return []
    }
  }

  protected async handleMessage(
    msg: Message,
    _lectic: Lectic,
    opt?: { inlineAttachments?: InlineAttachment[] }
  ) {
    if (msg.role === "assistant") {
      let results: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = []
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
            content: interaction.attachments.map((a) => ({
              type: "text" as const,
              text: a.content,
            })),
          })
        }

        const modelParts: OpenAI.Chat.Completions.ChatCompletionContentPartText[] = []
        const toolCalls: OpenAI.Chat.Completions.ChatCompletionMessageToolCall[] = []

        if (interaction.text.length > 0) {
          modelParts.push({ type: "text", text: interaction.text })
        }

        for (const call of interaction.calls) {
          toolCalls.push({
            type: "function",
            id: call.id ?? "undefined",
            function: {
              name: call.name,
              arguments: JSON.stringify(call.args),
            },
          })
        }

        results.push({
          name: msg.name,
          role: "assistant",
          content: modelParts,
          tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
        })

        if (interaction.calls.length > 0) {
          const attach = await collectAttachmentPartsFromCalls(
            interaction.calls,
            partToContent
          )
          if (attach.length > 0) {
            results.push({ role: "user", content: attach })
          }
        }

        for (const call of interaction.calls) {
          results.push({
            role: "tool",
            tool_call_id: call.id ?? "undefined",
            content: call.results
              .filter((r: ToolCallResult) => !isAttachmentMime(r.mimetype))
              .map((r: ToolCallResult) => ({
                type: "text" as const,
                text: r.toBlock().text,
              })),
          })
        }
      }

      return { messages: results, reset }
    }

    const parts: MessageAttachmentPart[] = await gatherMessageAttachmentParts(msg)

    const content: OpenAI.Chat.Completions.ChatCompletionContentPart[] = [
      { type: "text", text: msg.content },
    ]

    for (const part of parts) {
      try {
        const source = await partToContent(part)
        if (source) content.push(source)
      } catch (e) {
        const err = e instanceof Error ? e.message : String(e)
        content.push({
          type: "text",
          text:
            `<error>Something went wrong while retrieving ${part.title} ` +
            `from ${part.URI}:${err}</error>`,
        })
      }
    }

    if (opt?.inlineAttachments !== undefined) {
      const { textBlocks, inline } = await computeCmdAttachments(msg)
      for (const t of textBlocks) content.push({ type: "text", text: t })
      for (const t of opt.inlineAttachments) {
        content.push({ type: "text", text: t.content })
      }
      opt.inlineAttachments.push(...inline)
    }

    return { messages: [{ role: msg.role, content }], reset: false }
  }

  protected async createCompletion(opt: {
    messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[]
    lectic: Lectic
  }): Promise<BackendCompletion<OpenAI.Chat.Completions.ChatCompletion>> {
    const { messages, lectic } = opt

    const model = lectic.header.interlocutor.model ?? this.defaultModel

    Logger.debug("openai - messages", messages)

    const stream = this.client.chat.completions.stream({
      messages: [developerMessage(lectic), ...messages],
      model,
      temperature: lectic.header.interlocutor.temperature,
      max_completion_tokens: lectic.header.interlocutor.max_tokens,
      prompt_cache_retention: SUPPORTS_PROMPT_CACHE_RETENTION.includes(model)
        ? "24h"
        : undefined,
      stream: true,
      tools: getTools(lectic),
    })

    async function* text(): AsyncGenerator<string> {
      for await (const event of stream) {
        yield event.choices[0].delta.content || ""
      }
    }

    return {
      text: text(),
      final: stream.finalChatCompletion(),
    }
  }

  protected finalHasToolCalls(final: OpenAI.Chat.Completions.ChatCompletion) {
    const msg = final.choices[0]?.message
    return (msg?.tool_calls?.length ?? 0) > 0
  }

  protected finalUsage(
    final: OpenAI.Chat.Completions.ChatCompletion
  ): BackendUsage | undefined {
    const usageData = final.usage
    if (!usageData) return undefined

    return {
      input: usageData.prompt_tokens,
      cached: usageData.prompt_tokens_details?.cached_tokens ?? 0,
      output: usageData.completion_tokens,
      total: usageData.total_tokens,
    }
  }

  protected applyReset(
    messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[],
    resetAttachments: InlineAttachment[],
  ) {
    messages.length = 0
    messages.push({
      role: "user",
      content: resetAttachments.map((h) => ({ type: "text", text: h.content })),
    })
  }

  protected appendAssistantMessage(
    messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[],
    final: OpenAI.Chat.Completions.ChatCompletion,
    lectic: Lectic
  ) {
    const msg = final.choices[0]?.message
    messages.push({
      name: lectic.header.interlocutor.name,
      role: "assistant",
      tool_calls: msg?.tool_calls,
      content: msg?.content,
    })
  }

  protected getToolCallEntries(
    final: OpenAI.Chat.Completions.ChatCompletion,
    registry: ToolRegistry
  ): ToolCallEntry[] {
    const msg = final.choices[0]?.message

    return (msg?.tool_calls ?? [])
      .filter((call) => call.type === "function")
      .map((call) => {
        const tool = registry[call.function.name] ?? null
        const args = destrictifyToolResults(tool, call.function.arguments)
        return { id: call.id, name: call.function.name, args }
      })
  }

  protected async appendToolResults(opt: {
    messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[]
    final: OpenAI.Chat.Completions.ChatCompletion
    realized: ToolCall[]
    hookAttachments: InlineAttachment[]
    lectic: Lectic
  }): Promise<void> {
    const { messages, realized, hookAttachments } = opt

    const parts = await collectAttachmentPartsFromCalls(realized, partToContent)

    for (const h of hookAttachments) {
      parts.push({ type: "text", text: h.content })
    }

    if (parts.length > 0) {
      messages.push({ role: "user", content: parts })
    }

    for (const call of realized) {
      const callId = call.id ?? "undefined"
      messages.push({
        role: "tool",
        tool_call_id: callId,
        content: call.results
          .filter((r: ToolCallResult) => !isAttachmentMime(r.mimetype))
          .map((r: ToolCallResult) => ({
            type: "text" as const,
            text: r.toBlock().text,
          })),
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
