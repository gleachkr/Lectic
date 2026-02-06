import Anthropic from "@anthropic-ai/sdk"
import { AnthropicBedrock } from "@anthropic-ai/bedrock-sdk"
import type { Message } from "../types/message"
import type { Lectic, HasModel } from "../types/lectic"
import type { BackendCompletion, BackendUsage, } from "../types/backend"
import { Backend } from "../types/backend"
import { LLMProvider } from "../types/provider"
import type { ToolCall, ToolCallResult } from "../types/tool"
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
import { inlineReset, type InlineAttachment } from "../types/inlineAttachment"
import type { MessageStream } from "@anthropic-ai/sdk/lib/MessageStream.mjs"
import type { ToolCallEntry, ToolRegistry } from "../types/backend"
import { transformJSONSchema } from "@anthropic-ai/sdk/lib/transform-json-schema.js"

// Yield only text deltas from an Anthropic stream, plus blank lines when
// server tool use blocks begin (to preserve formatting semantics).
export async function* anthropicTextChunks(
  stream: MessageStream
): AsyncGenerator<string> {
  for await (const messageEvent of stream) {
    if (
      messageEvent.type === "content_block_delta" &&
      messageEvent.delta.type === "text_delta"
    ) {
      yield messageEvent.delta.text
    }
    if (
      messageEvent.type === "content_block_start" &&
      messageEvent.content_block?.type === "server_tool_use"
    ) {
      yield "\n\n"
    }
  }
}

async function partToContent(part: MessageAttachmentPart) {
  const media_type = part.mimetype
  let bytes = part.bytes
  if (!(media_type && bytes)) return null

  switch (media_type) {
    case "image/gif":
    case "image/jpeg":
    case "image/webp":
    case "image/png":
      return {
        type: "image",
        source: {
          type: "base64",
          media_type,
          data: Buffer.from(bytes).toString("base64"),
        },
      } as const

    case "application/pdf":
      if (part.fragmentParams) {
        bytes = await pdfFragment(bytes, part.fragmentParams)
      }
      return {
        type: "document",
        title: part.title,
        source: {
          type: "base64",
          media_type: "application/pdf",
          data: Buffer.from(bytes).toString("base64"),
        },
      } as const

    case "text/plain":
      return {
        type: "document",
        title: part.title,
        source: {
          type: "text",
          media_type: "text/plain",
          data: Buffer.from(bytes).toString(),
        },
      } as const

    default:
      return {
        type: "text",
        text: `<error>Media type ${media_type} is not supported.</error>`,
      } as const
  }
}

function updateCache(messages: Anthropic.Messages.MessageParam[]) {
  let idx = 0
  for (const message of messages) {
    if (message.content.length > 0) {
      const last = message.content[message.content.length - 1]
      if (
        typeof last !== "string" &&
        last.type !== "redacted_thinking" &&
        last.type !== "thinking"
      ) {
        if (idx === messages.length - 1) {
          last.cache_control = { type: "ephemeral" }
        } else {
          delete last.cache_control
        }
      }
    }
    idx++
  }
}

function getTools(lectic: Lectic): Anthropic.Messages.ToolUnion[] {
  const nativeTools = (lectic.header.interlocutor.tools || [])
    .filter((tool) => "native" in tool)
    .map((tool) => tool.native)

  const tools: Anthropic.Messages.ToolUnion[] = []
  for (const tool of Object.values(lectic.header.interlocutor.registry ?? {})) {
    tools.push({
      name: tool.name,
      description: tool.description,
      input_schema: {
        type: "object",
        properties: tool.parameters,
        required: tool.required,
      },
    })
  }

  if (nativeTools.find((tool) => tool === "search")) {
    tools.push({
      name: "web_search",
      type: "web_search_20250305",
    })
  }

  return tools
}

export class AnthropicBackend extends Backend<
  Anthropic.Messages.MessageParam,
  Anthropic.Messages.Message
> {
  provider = LLMProvider.Anthropic
  defaultModel = "claude-sonnet-4-20250514"
  client: Anthropic | AnthropicBedrock

  constructor() {
    super()
    this.client = new Anthropic({
      apiKey: process.env["ANTHROPIC_API_KEY"],
      maxRetries: 5,
    })
  }

  async listModels(): Promise<string[]> {
    // Bedrock model enumeration via Anthropic SDK is not supported here.
    if (!("models" in this.client)) return []

    try {
      const page = await this.client.models.list()
      const ids: string[] = []
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
      const results: Anthropic.Messages.MessageParam[] = []
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
              type: "text",
              text: a.content,
            })),
          })
        }

        const modelParts: Anthropic.Messages.ContentBlockParam[] = []
        const userParts: Anthropic.Messages.ContentBlockParam[] = []

        if (interaction.text.length > 0) {
          modelParts.push({ type: "text" as const, text: interaction.text })
        }

        if (interaction.calls.length > 0) {
          for (const call of interaction.calls) {
            const call_id = call.id ?? Bun.randomUUIDv7()
            modelParts.push({
              type: "tool_use",
              name: call.name,
              id: call_id,
              input: call.args,
            })

            userParts.push({
              type: "tool_result",
              tool_use_id: call_id,
              content: call.results
                .filter((r) => !isAttachmentMime(r.mimetype))
                .map((r) => ({ type: "text" as const, text: r.toBlock().text })),
              is_error: call.isError,
            })
          }

          userParts.push(
            ...await collectAttachmentPartsFromCalls(interaction.calls, partToContent)
          )
        }

        if (modelParts.length > 0) {
          results.push({ role: "assistant", content: modelParts })
        }
        if (userParts.length > 0) {
          results.push({ role: "user", content: userParts })
        }
      }

      return { messages: results, reset }
    }

    if (msg.role === "assistant") {
      return {
        messages: [
          {
            role: "user" as const,
            content: [
              {
                type: "text" as const,
                text: wrapText({
                  text: msg.content || "…",
                  name: msg.name,
                }),
              },
            ],
          },
        ],
        reset: false,
      }
    }

    const parts: MessageAttachmentPart[] = await gatherMessageAttachmentParts(msg)

    const content: Anthropic.Messages.ContentBlockParam[] = [
      {
        type: "text",
        text: msg.content || "…",
      },
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
      for (const t of opt.inlineAttachments) {
        content.push({ type: "text", text: t.content })
      }
    }

    return { messages: [{ role: msg.role, content }], reset: false }
  }

  protected async createCompletion(opt: {
    messages: Anthropic.Messages.MessageParam[]
    lectic: Lectic & HasModel
  }): Promise<BackendCompletion<Anthropic.Messages.Message>> {
    const { messages, lectic } = opt

    if (!lectic.header.interlocutor.nocache) updateCache(messages)

    const model = lectic.header.interlocutor.model

    const output_schema = lectic.header.interlocutor.output_schema
    const output_config = output_schema
      ? {
          format: {
            type: "json_schema" as const,
            schema: transformJSONSchema(output_schema),
          },
        }
      : undefined

    Logger.debug("anthropic - messages", messages)

    const stream = this.client.messages.stream({
      max_tokens: lectic.header.interlocutor.max_tokens || 2048,
      system: systemPrompt(lectic),
      messages,
      model,
      temperature: lectic.header.interlocutor.temperature,
      tools: getTools(lectic),
      output_config,
      thinking:
        lectic.header.interlocutor.thinking_budget !== undefined
          ? {
              type: "enabled",
              budget_tokens: lectic.header.interlocutor.thinking_budget,
            }
          : undefined,
    })

    return {
      text: anthropicTextChunks(stream),
      final: stream.finalMessage(),
    }
  }

  protected finalHasToolCalls(final: Anthropic.Messages.Message): boolean {
    return final.stop_reason === "tool_use"
  }

  protected finalUsage(final: Anthropic.Messages.Message): BackendUsage {
    const input =
      final.usage.input_tokens +
      (final.usage.cache_read_input_tokens ?? 0) +
      (final.usage.cache_creation_input_tokens ?? 0)

    return {
      input,
      cached: final.usage.cache_read_input_tokens ?? 0,
      output: final.usage.output_tokens,
      total: input + final.usage.output_tokens,
    }
  }

  protected applyReset(
    messages: Anthropic.Messages.MessageParam[],
    resetAttachments: InlineAttachment[],
  ): void {
    messages.length = 0
    messages.push({
      role: "user",
      content: resetAttachments.map((h) => ({
        type: "text" as const,
        text: h.content,
      })),
    })
  }

  protected appendAssistantMessage(
    messages: Anthropic.Messages.MessageParam[],
    final: Anthropic.Messages.Message,
    _lectic: Lectic
  ): void {
    messages.push({ role: "assistant", content: final.content })
  }

  protected getToolCallEntries(
    final: Anthropic.Messages.Message,
    _registry: ToolRegistry
  ): ToolCallEntry[] {
    return final.content
      .filter((blk): blk is Anthropic.Messages.ToolUseBlock => blk.type === "tool_use")
      .map((blk) => ({ id: blk.id, name: blk.name, args: blk.input }))
  }

  protected async appendToolResults(opt: {
    messages: Anthropic.Messages.MessageParam[]
    final: Anthropic.Messages.Message
    realized: ToolCall[]
    hookAttachments: InlineAttachment[]
    lectic: Lectic
  }): Promise<void> {
    const { messages, realized, hookAttachments } = opt

    const content: Anthropic.Messages.ContentBlockParam[] = realized.map(
      (call: ToolCall) => {
        if (!call.id) {
          throw new Error("Missing tool call id for Anthropic tool_result")
        }
        return {
          type: "tool_result" as const,
          tool_use_id: call.id,
          is_error: call.isError,
          content: call.results
            .filter((r: ToolCallResult) => !isAttachmentMime(r.mimetype))
            .map((r: ToolCallResult) => ({
              type: "text" as const,
              text: r.toBlock().text,
            })),
        }
      }
    )

    content.push(...await collectAttachmentPartsFromCalls(realized, partToContent))

    for (const h of hookAttachments) {
      content.push({ type: "text", text: h.content })
    }

    if (content.length > 0) messages.push({ role: "user", content })
  }
}

export class AnthropicBedrockBackend extends AnthropicBackend {
  client: AnthropicBedrock

  constructor() {
    super()
    this.provider = LLMProvider.AnthropicBedrock
    this.defaultModel = "us.anthropic.claude-sonnet-4-20250514-v1:0"
    this.client = new AnthropicBedrock({ maxRetries: 5 })
  }
}
