import { Logger } from "../logging/logger"
import { type Lectic, type HasModel } from "./lectic"
import { type Message } from "./message"
import { getActiveHooks, type Hook, type HookEvents } from "./hook"
import { serializeCall, ToolCallResults, type Tool, type ToolCall} from "./tool"
import { type LLMProvider } from "./provider"
import {
  inlineNotFinal,
  inlineReset,
  serializeInlineAttachment,
  type InlineAttachment,
} from "./inlineAttachment"
import { isObjectRecord } from "./guards"

export type BackendUsage = {
  input: number
  cached: number
  output: number
  total: number
}

function parseHookOutput(text: string): {
  content: string
  attributes: Record<string, string>
} {
  const lines = text.split("\n")
  const attributes: Record<string, string> = {}
  let headerEnd = 0

  // Parse headers until blank line or non-header.
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const match = /^LECTIC:([A-Za-z0-9_-]+)(?::(.*))?$/.exec(line)
    if (match) {
      attributes[match[1].toLowerCase()] = match[2] ?? "true"
      headerEnd = i + 1
      continue
    }

    if (line.trim().length === 0 && Object.keys(attributes).length > 0) {
      headerEnd = i + 1
    }
    break
  }

  const content = lines.slice(headerEnd).join("\n")
  return { content, attributes }
}

type RunHookOptions = {
  stdin?: string
  collectInline?: boolean
}

function runHooksInternal(
  hooks: Hook[],
  event: keyof HookEvents,
  env: Record<string, string>,
  opt?: RunHookOptions
): InlineAttachment[] {
  const inline: InlineAttachment[] = []
  const active = getActiveHooks(hooks, event, env)

  for (const hook of active) {
    try {
      const { output } = hook.execute(env, opt?.stdin)
      if (opt?.collectInline === false) continue
      if (output && output.trim().length > 0) {
        const { content, attributes } = parseHookOutput(output)
        inline.push({
          kind: "hook",
          command: hook.do,
          content,
          mimetype: "text/plain",
          attributes: Object.keys(attributes).length > 0 ? attributes : undefined,
        })
      }
    } catch (e) {
      Logger.debug(`An error occurred during the hook execution of ${hook.do}`, e)
    }
  }

  return inline
}

export function runHooks(
  hooks: Hook[],
  event: keyof HookEvents,
  env: Record<string, string>,
  stdin?: string
): InlineAttachment[] {
  return runHooksInternal(hooks, event, env, { stdin, collectInline: true })
}

export function runHooksNoInline(
  hooks: Hook[],
  event: keyof HookEvents,
  env: Record<string, string>,
  stdin?: string
): void {
  runHooksInternal(hooks, event, env, { stdin, collectInline: false })
}

export function getScopedHooks(lectic: Lectic): Hook[] {
  return lectic.header.hooks.concat(
    lectic.header.interlocutor.active_hooks ?? []
  )
}

export function emitAssistantMessageEvent(
  text: string | undefined | null,
  lectic: Lectic,
  opt?: {
    toolUseDone?: boolean
    usage?: BackendUsage
    loopCount?: number
    finalPassCount?: number
  }
): InlineAttachment[] {
  const baseEnv: Record<string, string> = {
    LECTIC_INTERLOCUTOR: lectic.header.interlocutor.name,
    LECTIC_MODEL: lectic.header.interlocutor.model ?? "default",
  }

  if (text) baseEnv["ASSISTANT_MESSAGE"] = text
  if (opt?.toolUseDone) baseEnv["TOOL_USE_DONE"] = "1"

  if (opt?.usage) {
    baseEnv["TOKEN_USAGE_INPUT"] = opt.usage.input.toString()
    baseEnv["TOKEN_USAGE_OUTPUT"] = opt.usage.output.toString()
    baseEnv["TOKEN_USAGE_TOTAL"] = opt.usage.total.toString()
    baseEnv["TOKEN_USAGE_CACHED"] = opt.usage.cached.toString()
  }

  if (opt?.loopCount !== undefined) baseEnv["LOOP_COUNT"] = String(opt.loopCount)
  if (opt?.finalPassCount !== undefined) {
    baseEnv["FINAL_PASS_COUNT"] = String(opt.finalPassCount)
  }

  const allHooks = getScopedHooks(lectic)

  return runHooks(
    allHooks,
    "assistant_message",
    baseEnv,
    lectic.body.snapshot({ closeBlock: true })
  )
}

export function emitUserMessageEvent(
  text: string | undefined | null,
  lectic: Lectic
): InlineAttachment[] {
  const baseEnv: Record<string, string> = {
    LECTIC_INTERLOCUTOR: lectic.header.interlocutor.name,
    LECTIC_MODEL: lectic.header.interlocutor.model ?? "default",
    MESSAGES_LENGTH: String(lectic.body.messages.length)
  }

  if (text) baseEnv["USER_MESSAGE"] = text

  const allHooks = getScopedHooks(lectic)

  return runHooks(allHooks, "user_message", baseEnv)
}

export type ToolRegistry = Record<string, Tool>

export type ToolCallEntry = { id?: string; name: string; args: unknown }

type ToolCallErrorKind =
  | "invalid_args"
  | "limit_exceeded"
  | "unknown_tool"
  | "blocked"
  | "error"

class ToolCallError extends Error {
  kind: ToolCallErrorKind

  constructor(kind: ToolCallErrorKind, message: string) {
    super(message)
    this.kind = kind
  }
}

function safeJSONStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "null"
  } catch {
    return JSON.stringify(String(value))
  }
}

function withUsageEnv(
  env: Record<string, string>,
  usage: BackendUsage | undefined
): Record<string, string> {
  if (!usage) return env

  env["TOKEN_USAGE_INPUT"] = String(usage.input)
  env["TOKEN_USAGE_OUTPUT"] = String(usage.output)
  env["TOKEN_USAGE_TOTAL"] = String(usage.total)
  env["TOKEN_USAGE_CACHED"] = String(usage.cached)
  return env
}

export async function resolveToolCalls(
  entries: ToolCallEntry[],
  registry: ToolRegistry,
  opt?: {
    limitExceeded?: boolean
    lectic?: Lectic
    usage?: BackendUsage
  }
): Promise<ToolCall[]> {
  const limitMsg =
    "Tool usage limit exceeded, no further tool calls will be allowed"
  const invalidArgsMsg =
    "The tool input isn't the right type. Tool inputs need to be returned as " +
    "objects."

  const globalHooks = opt?.lectic?.header.hooks ?? []
  const interlocutorHooks = opt?.lectic?.header.interlocutor.active_hooks ?? []

  const results: ToolCall[] = await Promise.all(entries.map(async (entry) => {
    const id = entry.id
    const name = entry.name
    const rawArgs = entry.args
    const tool = registry[name]
    const args = isObjectRecord(rawArgs) ? rawArgs : {}
    const toolHooks = tool ? tool.hooks : []
    const hooks = [...globalHooks, ...interlocutorHooks, ...toolHooks]
    const argsJSON = safeJSONStringify(rawArgs)
    const startedAt = Date.now()

    let isError = true
    let callResults = ToolCallResults("")
    let callError: { type: ToolCallErrorKind, message: string } | undefined

    try {
      if (!isObjectRecord(rawArgs)) {
        throw new ToolCallError("invalid_args", invalidArgsMsg)
      }

      if (opt?.limitExceeded) {
        throw new ToolCallError("limit_exceeded", limitMsg)
      }

      if (!tool) {
        throw new ToolCallError("unknown_tool", `Unrecognized tool name: ${name}`)
      }

      const preEnv = withUsageEnv({
        TOOL_NAME: name,
        TOOL_ARGS: argsJSON,
      }, opt?.usage)

      const preHooks = getActiveHooks(hooks, "tool_use_pre", preEnv)
      for (const hook of preHooks) {
        const { exitCode } = hook.execute(preEnv)
        if (exitCode !== 0) {
          throw new ToolCallError("blocked", "Tool use permission denied")
        }
      }

      callResults = await tool.call(args)
      isError = false
    } catch (e) {
      const msg = e instanceof Error
        ? e.message
        : `An error of unknown type occurred during a call to ${name}`
      const type = e instanceof ToolCallError ? e.kind : "error"
      callError = { type, message: msg }
      callResults = ToolCallResults(msg)
      isError = true
    } finally {
      const postEnv = withUsageEnv({
        TOOL_NAME: name,
        TOOL_ARGS: argsJSON,
        TOOL_DURATION_MS: String(Date.now() - startedAt),
      }, opt?.usage)

      if (callError) {
        postEnv["TOOL_CALL_ERROR"] = safeJSONStringify(callError)
      } else {
        postEnv["TOOL_CALL_RESULTS"] = safeJSONStringify(callResults)
      }

      runHooksNoInline(hooks, "tool_use_post", postEnv)
    }

    return { name, args, id, isError, results: callResults }
  }))

  return results
}

export type BackendCompletion<TFinal> = {
  text: AsyncIterable<string>
  final: Promise<TFinal>
}

export type AssistantPassInfo = {
  loopCount: number
  finalPassCount: number
  hasToolCalls: boolean
  usage: BackendUsage | undefined
}

export type BackendEvaluateOptions = {
  onAssistantPassText?: (text: string, info: AssistantPassInfo) => void
}

export abstract class Backend<TMessage, TFinal> {
  abstract provider: LLMProvider
  abstract defaultModel: string

  // List available model identifiers for this backend/provider.
  // Implementations should use the provider SDK (no direct fetch).
  // May return an empty list when unsupported (e.g., Bedrock for now).
  abstract listModels(): Promise<string[]>

  protected abstract handleMessage(
    msg: Message,
    lectic: Lectic,
    opt?: { inlineAttachments?: InlineAttachment[] }
  ): Promise<{ messages: TMessage[]; reset: boolean }>

  protected abstract createCompletion(opt: {
    messages: TMessage[]
    lectic: Lectic & HasModel
  }): Promise<BackendCompletion<TFinal>>

  protected abstract finalHasToolCalls(final: TFinal): boolean

  protected abstract finalUsage(final: TFinal): BackendUsage | undefined

  protected abstract applyReset(
    messages: TMessage[],
    resetAttachments: InlineAttachment[],
  ): void

  protected abstract appendAssistantMessage(
    messages: TMessage[],
    final: TFinal,
    lectic: Lectic
  ): void

  protected abstract getToolCallEntries(
    final: TFinal,
    registry: ToolRegistry
  ): ToolCallEntry[]

  protected abstract appendToolResults(opt: {
    messages: TMessage[]
    final: TFinal
    realized: ToolCall[]
    hookAttachments: InlineAttachment[]
    lectic: Lectic
  }): Promise<void>

  async *evaluate(
    lectic: Lectic,
    opt?: BackendEvaluateOptions
  ): AsyncIterable<string> {
    const messages: TMessage[] = []

    // Only execute user_message hooks and inject attachments when handling
    // a final user message
    const lastIdx = lectic.body.messages.length - 1
    const lastIsUser =
      lastIdx >= 0 && lectic.body.messages[lastIdx].role === "user"

    let inlinePreface: InlineAttachment[] = []

    for (let i = 0; i < lectic.body.messages.length; i++) {
      const m = lectic.body.messages[i]

      if (m.role === "user" && lastIsUser && i === lastIdx) {
        const hookAttachments = emitUserMessageEvent(m.content, lectic)
        // these are attachments generated during macro expansion and
        // directive handling
        const directiveAttachments = m.inlineAttachments

        // XXX: Make sure to keep transcript order aligned with the
        // provider-visible order. This prevents the initial request from
        // seeing a different ordering than subsequent runs that replay cached
        // inline attachments.
        inlinePreface = [...hookAttachments, ...directiveAttachments]

        const { messages: newMsgs } = await this.handleMessage(m, lectic, {
          inlineAttachments: inlinePreface,
        })
        messages.push(...newMsgs)
      } else {
        const { messages: newMsgs, reset } = await this.handleMessage(m, lectic)
        if (reset) messages.length = 0
        messages.push(...newMsgs)
      }
    }

    lectic.header.interlocutor.model ??= this.defaultModel

    yield* this.runConversationLoop({
      messages,
      lectic: lectic as Lectic & HasModel,
      inlinePreface,
      onAssistantPassText: opt?.onAssistantPassText,
    })
  }

  protected async *runConversationLoop(opt: {
    messages: TMessage[]
    lectic: Lectic & HasModel
    inlinePreface: InlineAttachment[]
    onAssistantPassText?: (text: string, info: AssistantPassInfo) => void
  }): AsyncGenerator<string> {
    const { messages, lectic } = opt

    const registry = lectic.header.interlocutor.registry ?? {}
    const maxToolUse = lectic.header.interlocutor.max_tool_use ?? 10

    let loopCount = 0
    let finalPassCount = 0

    // Preface inline attachments at the top of the assistant block.
    if (opt.inlinePreface.length > 0) {
      const preface =
        opt.inlinePreface.map(serializeInlineAttachment).join("\n\n") +
        "\n\n"
      yield preface
    }

    let pendingHookRes: InlineAttachment[] = []

    for (;;) {
      const { text, final } = await this.createCompletion({ messages, lectic })

      let assistant = ""
      for await (const chunk of text) {
        yield chunk
        assistant += chunk
      }

      const reply = await final

      const hasToolCalls = this.finalHasToolCalls(reply)
      const usage = this.finalUsage(reply)

      opt.onAssistantPassText?.(assistant, {
        loopCount,
        finalPassCount,
        hasToolCalls,
        usage,
      })

      pendingHookRes = emitAssistantMessageEvent(assistant, lectic, {
        toolUseDone: !hasToolCalls,
        usage,
        loopCount,
        finalPassCount,
      })

      if (pendingHookRes.length > 0) {
        if (!hasToolCalls) finalPassCount++
        yield "\n\n"
        yield pendingHookRes.map(serializeInlineAttachment).join("\n\n")
        yield "\n\n"
      }

      const needsFollowUp =
        hasToolCalls || pendingHookRes.some((a) => inlineNotFinal(a))

      if (!needsFollowUp) return

      yield "\n\n"
      loopCount++

      if (loopCount > maxToolUse + 2) {
        yield "<error>Runaway tool use!</error>"
        return
      }

      const resetAttachments = pendingHookRes.filter(inlineReset)
      if (resetAttachments.length > 0) {
        this.applyReset(messages, resetAttachments)
      }

      this.appendAssistantMessage(messages, reply, lectic)

      const entries = this.getToolCallEntries(reply, registry)

      const realized = await resolveToolCalls(entries, registry, {
        limitExceeded: loopCount > maxToolUse,
        lectic,
        usage,
      })

      for (const call of realized) {
        const theTool = call.name in registry ? registry[call.name] : null
        yield serializeCall(theTool, call)
        yield "\n\n"
      }

      await this.appendToolResults({
        messages,
        final: reply,
        realized,
        hookAttachments: pendingHookRes.filter((a) => !inlineReset(a)),
        lectic,
      })
    }
  }
}
