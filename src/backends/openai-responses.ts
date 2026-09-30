import OpenAI from "openai"
import type { Message } from "../types/message"
import type { HasModel, Lectic } from "../types/lectic"
import type { BackendCompletion, BackendUsage, StreamChunk } from "../types/backend"
import { Backend } from "../types/backend"
import { LLMProvider } from "../types/provider"
import { type MessageAttachmentPart } from "../types/attachment"
import { Logger } from "../logging/logger"
import {
  systemPrompt,
  wrapForeignAssistantMessage,
  pdfFragment,
  collectAttachmentPartsFromCalls,
  gatherMessageAttachmentParts,
  isAttachmentMime,
  inlineAttachmentToPart,
  destrictifyToolResults,
} from "./common.ts"
import { inlineReset, type InlineAttachment } from "../types/inlineAttachment"
import {
  toolCallArguments,
  toolParameters,
  type ToolCall,
} from "../types/tool"
import type { ToolCallEntry, ToolRegistry } from "../types/backend"
import { openAIToolSchema, strictify } from "../types/openaiSchema.ts"
import type { ThoughtBlock } from "../types/thought"
import { codexServiceTier, openAIServiceTier } from "./modelControls"

const WEBSOCKET_STREAM_MAX_RETRIES = 5
const WEBSOCKET_STREAM_RETRY_INITIAL_DELAY_MS = 200

const SUPPORTS_PROMPT_CACHE_RETENTION = [
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
  "gpt-5.5",
  "gpt-5.5-pro",
  "gpt-5.4",
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

function thoughtBlockToReasoningItem(
  thought: ThoughtBlock
): OpenAI.Responses.ResponseReasoningItem {
  const summary = (thought.summary ?? []).map((s) => ({
    type: "summary_text" as const,
    text: s,
  }))

  const content = (thought.content ?? []).map((s) => ({
    type: "reasoning_text" as const,
    text: s,
  }))

  const encrypted =
    thought.opaque?.["encrypted_content"]

  const status =
    thought.status === "in_progress" ||
    thought.status === "completed" ||
    thought.status === "incomplete"
      ? thought.status
      : undefined

  return {
    type: "reasoning",
    id: thought.id ?? Bun.randomUUIDv7(),
    summary,
    content: content.length > 0 ? content : undefined,
    encrypted_content: encrypted,
    status,
  }
}

function errorChainText(error: unknown): string {
  const parts: string[] = []
  const seen = new Set<unknown>()
  let current = error

  while (current !== undefined && current !== null && !seen.has(current)) {
    seen.add(current)
    if (current instanceof Error) {
      parts.push(current.message)
      current = current.cause
    } else {
      parts.push(String(current))
      break
    }
  }

  return parts.join(": ")
}

function isRetryableWebSocketStreamError(error: unknown): boolean {
  if (error instanceof DOMException && error.name === "AbortError") return false

  const message = errorChainText(error)
  return /websocket closed before response\.completed/i.test(message) ||
    /websocket stream error/i.test(message) ||
    /idle timeout (?:waiting for|sending) websocket/i.test(message)
}

function retryContextItems(
  accumulator: OpenAI.Responses.ResponseOutputItem[]
): OpenAI.Responses.ResponseInputItem[] {
  return accumulator.filter((item) =>
    item !== undefined &&
    (item.type === "message" || item.type === "reasoning")
  )
}

function normalizeResponseOutput(
  response: OpenAI.Responses.Response,
  accumulator: OpenAI.Responses.ResponseOutputItem[]
): OpenAI.Responses.Response {
  const outputMissing =
    !Array.isArray(response.output) || response.output.length === 0

  if (outputMissing && accumulator.length > 0) {
    response.output = accumulator.filter((item) => item !== undefined).map((item) => {
      if (item.type === "function_call") {
        return {
          ...item,
          parsed_arguments: null,
        } as OpenAI.Responses.ResponseOutputItem
      }

      if (item.type === "message") {
        return {
          ...item,
          content: item.content.map((content) =>
            content.type === "output_text"
              ? { ...content, parsed: null }
              : content
          ),
        }
      }

      return item
    })
  } else if (!Array.isArray(response.output)) {
    response.output = []
  }

  return response
}

function getTools(lectic: Lectic): OpenAI.Responses.Tool[] {
  const tools: OpenAI.Responses.Tool[] = []

  const nativeTools = (lectic.header.interlocutor.tools || [])
    .filter((tool) => "native" in tool)
    .map((tool) => tool.native)

  for (const tool of Object.values(lectic.header.interlocutor.registry ?? {})) {
    const parameters = openAIToolSchema({
      type: "object",
      properties: toolParameters(tool),
      required: tool.required,
    })

    tools.push({
      type: "function",
      name: tool.name,
      description: tool.description,
      strict: parameters.strict,
      parameters: parameters.schema,
    })
  }

  if (nativeTools.find((tool) => tool === "search")) {
    tools.push({ type: "web_search" })
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
  apiKeyEnv: string
  apiKeyValue?: string
  url?: string
  cache_retention: boolean = true

  constructor(opt: {
    apiKeyEnv: string
    apiKeyValue?: string
    provider: LLMProvider
    url?: string
    defaultModel: string
  }) {
    super()
    this.provider = opt.provider
    this.apiKeyEnv = opt.apiKeyEnv
    this.apiKeyValue = opt.apiKeyValue
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
        const resetsContext = interaction.attachments.some(inlineReset)
        if (resetsContext) {
          results.length = 0
          reset = true
        }

        if (interaction.attachments.length > 0) {
          const attContent: OpenAI.Responses.ResponseInputContent[] = []
          for (const a of interaction.attachments) {
            if (isAttachmentMime(a.mimetype)) {
              const block = await partToContent(inlineAttachmentToPart(a))
              if (block) attContent.push(block)
            } else {
              attContent.push({ type: "input_text" as const, text: a.content })
            }
          }
          if (attContent.length > 0) {
            results.push({ role: "user", content: attContent })
          }
        }

        if (resetsContext) continue

        const thoughts = [...interaction.thoughts].sort(
          (a, b) => (a.order ?? 0) - (b.order ?? 0)
        )
        for (const thought of thoughts) {
          if (thought.provider && thought.provider !== "openai") continue
          results.push(thoughtBlockToReasoningItem(thought))
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
            arguments: JSON.stringify(toolCallArguments(call)),
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
              text: wrapForeignAssistantMessage(msg),
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
        if (isAttachmentMime(t.mimetype)) {
          const block = await partToContent(inlineAttachmentToPart(t))
          if (block) content.push(block)
        } else {
          content.push({ type: "input_text", text: t.content })
        }
      }
    }
    const messages : OpenAI.Responses.ResponseInput = [{ role: msg.role, content }]
    return { messages, reset: false }
  }

  protected webSocketStreamRetryDelay(attempt: number): number {
    const exponent = Math.max(0, attempt - 1)
    const base = WEBSOCKET_STREAM_RETRY_INITIAL_DELAY_MS * (2 ** exponent)
    const jitter = 0.9 + Math.random() * 0.2
    return Math.floor(base * jitter)
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
    const verbosity = lectic.header.interlocutor.verbosity
    const text = textConfig || verbosity
      ? {
          ...textConfig,
          ...(verbosity ? { verbosity } : {}),
        }
      : undefined
    const requestedTier = lectic.header.interlocutor.service_tier
    const serviceTier = this.provider === LLMProvider.Codex
      ? codexServiceTier(requestedTier)
      : openAIServiceTier(requestedTier)

    Logger.debug("openai - messages", messages)

    const startStream = () => this.client.responses.stream({
      instructions: systemPrompt(lectic),
      input: messages,
      model,
      include: ["reasoning.encrypted_content", "code_interpreter_call.outputs"],
      prompt_cache_key: lectic.header.id,
      prompt_cache_retention:
        this.cache_retention && SUPPORTS_PROMPT_CACHE_RETENTION.includes(model)
          ? "24h"
          : undefined,
      temperature: lectic.header.interlocutor.temperature,
      max_output_tokens: lectic.header.interlocutor.max_tokens,
      reasoning: lectic.header.interlocutor.thinking_effort
        ? { effort: lectic.header.interlocutor.thinking_effort }
        : undefined,
      tools: getTools(lectic),
      text,
      service_tier: serviceTier,
      store: false,
    })

    let stream = startStream()
    let resolveFinal!: (response: OpenAI.Responses.Response) => void
    let rejectFinal!: (error: unknown) => void
    const final = new Promise<OpenAI.Responses.Response>((resolve, reject) => {
      resolveFinal = resolve
      rejectFinal = reject
    })
    // The chunk consumer can fail before it awaits `final`. Mark the rejection
    // as observed while retaining the rejected promise for callers that do.
    void final.catch(() => {})

    const chunks = async function* (
      backend: OpenAIResponsesBackend
    ): AsyncGenerator<StreamChunk> {
      let thoughtOrder = 0
      let retryCount = 0

      for (;;) {
        // The Codex endpoint sometimes emits a response.completed payload with
        // no `output` field. Capture the raw snapshot so an SDK parser error
        // does not discard an otherwise complete response.
        let capturedSnapshot: OpenAI.Responses.Response | undefined
        const accumulator: OpenAI.Responses.ResponseOutputItem[] = []
        const unfinishedTextItems = new Set<number>()
        let iterationError: unknown

        const finalOutcome = stream.finalResponse().then(
          (response) => ({ ok: true as const, response }),
          (error: unknown) => ({ ok: false as const, error })
        )

        try {
          for await (const event of stream) {
            if (event.type === "response.completed") {
              capturedSnapshot = event.response
            }

            if (event.type === "response.output_text.delta") {
              const delta = event.delta || ""
              if (delta.length > 0) {
                unfinishedTextItems.add(event.output_index)
                yield { kind: "text", text: delta }
              }
            }

            if (event.type === "response.output_item.done") {
              accumulator[event.output_index] = event.item
              if (
                event.item.type === "message" &&
                event.item.status === "completed"
              ) {
                unfinishedTextItems.delete(event.output_index)
              }
            }

            if (
              event.type === "response.output_item.done" &&
              event.item.type === "reasoning"
            ) {
              const item = event.item
              const summary: string[] = []
              const content: string[] = []
              const opaque: Record<string, string> = {}

              if (Array.isArray(item.summary)) {
                for (const summaryPart of item.summary) {
                  if (
                    summaryPart.type === "summary_text" &&
                    summaryPart.text
                  ) {
                    summary.push(summaryPart.text)
                  }
                }
              }

              if (Array.isArray(item.content)) {
                for (const contentPart of item.content) {
                  if (
                    contentPart.type === "reasoning_text" &&
                    contentPart.text
                  ) {
                    content.push(contentPart.text)
                  }
                }
              }

              if (item.encrypted_content) {
                opaque["encrypted_content"] = item.encrypted_content
              }

              yield {
                kind: "thought",
                block: {
                  provider: "openai",
                  providerKind: "reasoning",
                  id: item.id,
                  status: item.status ?? undefined,
                  order: thoughtOrder++,
                  ...(summary.length > 0 ? { summary } : {}),
                  ...(content.length > 0 ? { content } : {}),
                  ...(Object.keys(opaque).length > 0 ? { opaque } : {}),
                },
              }
            }
          }
        } catch (error) {
          iterationError = error
        }

        const outcome = await finalOutcome
        const response = outcome.ok ? outcome.response : capturedSnapshot
        if (response) {
          resolveFinal(normalizeResponseOutput(response, accumulator))
          return
        }

        const error = iterationError ?? (outcome.ok ? undefined : outcome.error)
        // Text is append-only once yielded. A fresh generation cannot safely
        // replace an unfinished message or be expected to replay it verbatim.
        const canRetry =
          unfinishedTextItems.size === 0 &&
          retryCount <= WEBSOCKET_STREAM_MAX_RETRIES &&
          isRetryableWebSocketStreamError(error)

        if (!canRetry) {
          rejectFinal(error)
          throw error
        }

        const completedItems = retryContextItems(accumulator)
        if (completedItems.length > 0) messages.push(...completedItems)

        // One final immediate attempt lets a transport switch to its HTTPS
        // fallback after the normal WebSocket retry limit is exhausted.
        const delay = retryCount < WEBSOCKET_STREAM_MAX_RETRIES
          ? backend.webSocketStreamRetryDelay(retryCount + 1)
          : 0
        retryCount++
        Logger.debug("responses websocket stream disconnected; retrying", {
          retryCount,
          delay,
          error: errorChainText(error),
        })
        if (delay > 0) await Bun.sleep(delay)
        stream = startStream()
      }
    }

    return {
      chunks: chunks(this),
      final,
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
      messages.push(o as OpenAI.Responses.ResponseInputItem)
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
      if (isAttachmentMime(h.mimetype)) {
        const block = await partToContent(inlineAttachmentToPart(h))
        if (block) attachParts.push(block)
      } else {
        attachParts.push({ type: "input_text", text: h.content })
      }
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
      apiKey: this.apiKeyValue ?? (process.env[this.apiKeyEnv] || ""),
      baseURL: this.url,
    })
  }
}
