import { type Lectic, type HasModel } from "./lectic"
import { type Message } from "./message"
import { getActiveHooks, type Hook, type HookEvents } from "./hook"
import {
  serializeCall,
  ToolCallResults,
  type Tool,
  type ToolCall,
  type ToolCallResult,
} from "./tool"
import { type LLMProvider } from "./provider"
import {
  getProviderInlineAttachment,
  inlineRecordNotFinal,
  inlineReset,
  serializeInlineRecord,
  type InlineAttachment,
  type InlineRecord,
} from "./inlineAttachment"
import { isObjectRecord } from "./guards"
import { serializeThoughtBlock, type ThoughtBlock } from "./thought"
import { Logger } from "../logging/logger"

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
  runner?: HookExecutionTracker
}

function getHookLabel(hook: Hook): string {
  return hook.name
    ? `"${hook.name}"`
    : `"${hook.do.split("\n")[0]}"`
}

function hookExitError(
  hook: Hook,
  event: keyof HookEvents,
  exitCode: number
): Error {
  return new Error(
    `Hook ${getHookLabel(hook)} failed for ${event} ` +
    `with exit code ${exitCode}`
  )
}

function hookStartError(
  hook: Hook,
  event: keyof HookEvents,
  error: unknown
): Error {
  const message = error instanceof Error ? error.message : String(error)
  return new Error(
    `Hook ${getHookLabel(hook)} failed to start for ${event}: ${message}`
  )
}

type ActiveToolCall = {
  hooks: Hook[]
  env: Record<string, string>
  startedAt: number
}

export class HookExecutionTracker {
  private pending = new Set<Promise<void>>()
  private failures: Error[] = []
  private activeToolCalls = new Map<string, ActiveToolCall>()
  private emittedToolPostIds = new Set<string>()

  private debugFailure(
    kind: "background" | "detached",
    hook: Hook,
    event: keyof HookEvents,
    extra: Record<string, unknown>
  ) {
    Logger.debug(`${kind}_hook_failure`, {
      event,
      hook: getHookLabel(hook),
      ...extra,
    })
  }

  launch(
    hook: Hook,
    event: keyof HookEvents,
    env: Record<string, string>,
    stdin?: string
  ): void {
    if (hook.mode === "background") {
      this.launchBackground(hook, event, env, stdin)
      return
    }
    if (hook.mode === "detached") {
      this.launchDetached(hook, event, env, stdin)
    }
  }

  beginToolCall(
    callId: string,
    hooks: Hook[],
    env: Record<string, string>,
    startedAt: number
  ): void {
    this.activeToolCalls.set(callId, {
      hooks,
      env: { ...env },
      startedAt,
    })
  }

  shouldEmitToolUsePost(callId: string): boolean {
    this.activeToolCalls.delete(callId)
    if (this.emittedToolPostIds.has(callId)) return false
    this.emittedToolPostIds.add(callId)
    return true
  }

  emitInterruptedToolUsePost(signal: string): void {
    const failures: string[] = []

    for (const [callId, active] of [...this.activeToolCalls]) {
      if (!this.shouldEmitToolUsePost(callId)) continue

      const postEnv = {
        ...active.env,
        TOOL_DURATION_MS: String(Date.now() - active.startedAt),
        TOOL_CALL_ERROR: JSON.stringify({
          type: "error",
          message: `Interrupted by ${signal}`,
        }),
      }

      try {
        runHooksNoInline(
          active.hooks,
          "tool_use_post",
          postEnv,
          undefined,
          this,
        )
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        failures.push(message)
      }
    }

    if (failures.length > 0) {
      throw new Error(failures.join("\n"))
    }
  }

  private launchBackground(
    hook: Hook,
    event: keyof HookEvents,
    env: Record<string, string>,
    stdin?: string
  ): void {
    try {
      const exited = hook.executeBackground(env, stdin)
      const pending = exited.then((exitCode) => {
        if (exitCode === 0) return
        if (hook.allow_failure) {
          this.debugFailure("background", hook, event, { exitCode })
          return
        }
        this.failures.push(hookExitError(hook, event, exitCode))
      }).catch((error) => {
        if (hook.allow_failure) {
          this.debugFailure("background", hook, event, {
            error: error instanceof Error ? error.message : String(error),
          })
          return
        }
        this.failures.push(hookStartError(hook, event, error))
      }).finally(() => {
        this.pending.delete(pending)
      })
      this.pending.add(pending)
    } catch (error) {
      if (!hook.allow_failure) {
        throw hookStartError(hook, event, error)
      }
      this.debugFailure("background", hook, event, {
        error: error instanceof Error ? error.message : String(error),
        launch: true,
      })
    }
  }

  private launchDetached(
    hook: Hook,
    event: keyof HookEvents,
    env: Record<string, string>,
    stdin?: string
  ): void {
    try {
      const exited = hook.executeDetached(env, stdin)
      void exited.then((exitCode) => {
        if (exitCode === 0) return
        this.debugFailure("detached", hook, event, { exitCode })
      }).catch((error) => {
        this.debugFailure("detached", hook, event, {
          error: error instanceof Error ? error.message : String(error),
        })
      })
    } catch (error) {
      if (!hook.allow_failure) {
        throw hookStartError(hook, event, error)
      }
      this.debugFailure("detached", hook, event, {
        error: error instanceof Error ? error.message : String(error),
        launch: true,
      })
    }
  }

  async drain(): Promise<void> {
    while (this.pending.size > 0) {
      await Promise.allSettled([...this.pending])
    }

    if (this.failures.length === 0) return

    const messages = this.failures.map((error) => error.message)
    this.failures = []
    throw new Error(messages.join("\n"))
  }
}

function runHooksInternal(
  hooks: Hook[],
  event: keyof HookEvents,
  env: Record<string, string>,
  opt?: RunHookOptions
): InlineRecord[] {
  const inline: InlineRecord[] = []
  const active = getActiveHooks(hooks, event, env)
  const runner = opt?.runner ?? new HookExecutionTracker()

  for (const hook of active) {
    if (hook.mode !== "sync") {
      runner.launch(hook, event, env, opt?.stdin)
      continue
    }

    const { output, stderr, exitCode } = hook.execute(env, opt?.stdin)

    if (exitCode !== 0 && !hook.allow_failure) {
      const label = getHookLabel(hook)
      const stderrLine = stderr.trim()
      const suffix = stderrLine.length > 0
        ? `\nstderr: ${stderrLine}`
        : ""
      throw new Error(
        `Hook ${label} failed for ${event} with exit code ${exitCode}${suffix}`
      )
    }

    if (opt?.collectInline === false) continue
    if (output && output.trim().length > 0) {
      const { content, attributes } = parseHookOutput(output)

      const mergedAttributes = { ...attributes }
      if (hook.name) {
        mergedAttributes["name"] = hook.name
      }

      if (hook.inline_as === "comment") {
        inline.push({
          kind: "comment",
          content,
        })
      } else {
        inline.push({
          kind: "attachment",
          attachment: {
            kind: "hook",
            command: hook.do,
            content,
            mimetype: "text/plain",
            icon: hook.icon,
            attributes: Object.keys(mergedAttributes).length > 0
              ? mergedAttributes
              : undefined,
          },
        })
      }
    }
  }

  return inline
}

export function runHooks(
  hooks: Hook[],
  event: keyof HookEvents,
  env: Record<string, string>,
  stdin?: string,
  runner?: HookExecutionTracker
): InlineRecord[] {
  return runHooksInternal(hooks, event, env, {
    stdin,
    collectInline: true,
    runner,
  })
}

export function runHooksNoInline(
  hooks: Hook[],
  event: keyof HookEvents,
  env: Record<string, string>,
  stdin?: string,
  runner?: HookExecutionTracker
): void {
  runHooksInternal(hooks, event, env, {
    stdin,
    collectInline: false,
    runner,
  })
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
    runner?: HookExecutionTracker
  }
): InlineRecord[] {
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
    lectic.body.snapshot({ closeBlock: true }),
    opt?.runner,
  )
}

export function emitUserMessageEvent(
  text: string | undefined | null,
  lectic: Lectic,
  runner?: HookExecutionTracker
): InlineRecord[] {
  const baseEnv: Record<string, string> = {
    LECTIC_INTERLOCUTOR: lectic.header.interlocutor.name,
    LECTIC_MODEL: lectic.header.interlocutor.model ?? "default",
    MESSAGES_LENGTH: String(lectic.body.messages.length)
  }

  if (text) baseEnv["USER_MESSAGE"] = text

  const allHooks = getScopedHooks(lectic)

  return runHooks(allHooks, "user_message", baseEnv, undefined, runner)
}

export type ToolRegistry = Record<string, Tool>

export type ToolCallEntry = {
  id?: string
  name: string
  args: unknown
  /** Provider-specific opaque data to pass through. */
  opaque?: Record<string, string>
}

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

const MAX_TOOL_CALL_RESULTS_ENV_BYTES = 64 * 1024

function formatByteSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) {
    const kib = bytes / 1024
    return `${kib >= 10 ? kib.toFixed(0) : kib.toFixed(1)} KiB`
  }

  const mib = bytes / (1024 * 1024)
  return `${mib >= 10 ? mib.toFixed(0) : mib.toFixed(1)} MiB`
}

function setToolCallResultsEnv(
  env: Record<string, string>,
  results: ToolCallResult[]
): void {
  const json = safeJSONStringify(results)
  const size = new TextEncoder().encode(json).length

  if (size > MAX_TOOL_CALL_RESULTS_ENV_BYTES) {
    env["TOOL_CALL_WARNING"] =
      `tool call results too large (${formatByteSize(size)})`
    return
  }

  env["TOOL_CALL_RESULTS"] = json
}

export async function resolveToolCalls(
  entries: ToolCallEntry[],
  registry: ToolRegistry,
  opt?: {
    limitExceeded?: boolean
    lectic?: Lectic
    usage?: BackendUsage
    runner?: HookExecutionTracker
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
    const callId = id ?? Bun.randomUUIDv7()
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
        TOOL_CALL_ID: callId,
        TOOL_NAME: name,
        TOOL_ARGS: argsJSON,
      }, opt?.usage)

      opt?.runner?.beginToolCall(callId, hooks, preEnv, startedAt)

      const preHooks = getActiveHooks(hooks, "tool_use_pre", preEnv)
      for (const hook of preHooks) {
        if (hook.mode === "background" || hook.mode === "detached") {
          const runner = opt?.runner ?? new HookExecutionTracker()
          runner.launch(hook, "tool_use_pre", preEnv)
          continue
        }

        const { exitCode } = hook.execute(preEnv)
        if (exitCode !== 0 && !hook.allow_failure) {
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
        TOOL_CALL_ID: callId,
        TOOL_NAME: name,
        TOOL_ARGS: argsJSON,
        TOOL_DURATION_MS: String(Date.now() - startedAt),
      }, opt?.usage)

      if (callError) {
        postEnv["TOOL_CALL_ERROR"] = safeJSONStringify(callError)
      } else {
        setToolCallResultsEnv(postEnv, callResults)
      }

      const shouldEmitPost = opt?.runner?.shouldEmitToolUsePost(callId) ?? true
      if (shouldEmitPost) {
        runHooksNoInline(hooks, "tool_use_post", postEnv, undefined, opt?.runner)
      }
    }

    const opaque = entry.opaque
    return {
      name, args, id, isError, results: callResults,
      ...(opaque ? { opaque } : {}),
    }
  }))

  return results
}

export type StreamChunk =
  | { kind: "text"; text: string }
  | { kind: "thought"; block: ThoughtBlock }

export type BackendCompletion<TFinal> = {
  chunks: AsyncIterable<StreamChunk>
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
  onAssistantTextDelta?: (text: string) => void | Promise<void>
  hookRunner?: HookExecutionTracker
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
    let transcriptPreface: InlineRecord[] = []

    for (let i = 0; i < lectic.body.messages.length; i++) {
      const m = lectic.body.messages[i]

      if (m.role === "user" && lastIsUser && i === lastIdx) {
        const hookOutputs = emitUserMessageEvent(
          m.content,
          lectic,
          opt?.hookRunner,
        )
        // these are attachments generated during macro expansion and
        // directive handling
        const directiveAttachments = m.inlineAttachments

        const hookAttachments = hookOutputs
          .map(getProviderInlineAttachment)
          .filter((a): a is InlineAttachment => a !== null)

        // XXX: Make sure to keep transcript order aligned with the
        // provider-visible order. This prevents the initial request from
        // seeing a different ordering than subsequent runs that replay cached
        // inline attachments.
        inlinePreface = [...hookAttachments, ...directiveAttachments]
        transcriptPreface = [
          ...hookOutputs,
          ...directiveAttachments.map((attachment) => ({
            kind: "attachment" as const,
            attachment,
          })),
        ]

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
      transcriptPreface,
      onAssistantPassText: opt?.onAssistantPassText,
      onAssistantTextDelta: opt?.onAssistantTextDelta,
      hookRunner: opt?.hookRunner,
    })
  }

  protected async *runConversationLoop(opt: {
    messages: TMessage[]
    lectic: Lectic & HasModel
    transcriptPreface: InlineRecord[]
    onAssistantPassText?: (text: string, info: AssistantPassInfo) => void
    onAssistantTextDelta?: (text: string) => void | Promise<void>
    hookRunner?: HookExecutionTracker
  }): AsyncGenerator<string> {
    const { messages, lectic } = opt

    const registry = lectic.header.interlocutor.registry ?? {}
    const maxToolUse = lectic.header.interlocutor.max_tool_use ?? 10

    let loopCount = 0
    let finalPassCount = 0

    // Each segment (XML block, text run, tool call) is eagerly followed
    // by \n\n as soon as it completes. `trailingSep` prevents doubling
    // when consecutive blocks each try to emit a separator.
    // Starts false because the header already ends with \n\n.
    let trailingSep = false

    if (opt.transcriptPreface.length > 0) {
      yield opt.transcriptPreface.map(serializeInlineRecord).join("\n\n")
      yield "\n\n"
      trailingSep = true
    }

    let pendingHookRes: InlineRecord[] = []

    for (;;) {
      const { chunks, final } = await this.createCompletion({ messages, lectic })

      let assistant = ""
      for await (const chunk of chunks) {
        if (chunk.kind === "text") {
          trailingSep = false
          yield chunk.text
          assistant += chunk.text
          await opt.onAssistantTextDelta?.(chunk.text)
        } else {
          if (!trailingSep && assistant.length > 0) yield "\n\n"
          yield serializeThoughtBlock(chunk.block)
          yield "\n\n"
          trailingSep = true
        }
      }

      if (assistant.length > 0 && !trailingSep) {
        yield "\n\n"
        trailingSep = true
      }

      const reply = await final

      Logger.debug("model reply", reply)

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
        runner: opt.hookRunner,
      })

      if (pendingHookRes.length > 0) {
        if (!hasToolCalls && pendingHookRes.some(inlineRecordNotFinal)) {
          finalPassCount++
        }
        if (!trailingSep) yield "\n\n"
        yield pendingHookRes.map(serializeInlineRecord).join("\n\n")
        yield "\n\n"
        trailingSep = true
      }

      const needsFollowUp =
        hasToolCalls || pendingHookRes.some((a) => inlineRecordNotFinal(a))

      if (!needsFollowUp) return

      loopCount++

      if (loopCount > maxToolUse + 2) {
        if (!trailingSep) yield "\n\n"
        yield "<error>Runaway tool use!</error>\n\n"
        return
      }

      const hookAttachments = pendingHookRes
        .map(getProviderInlineAttachment)
        .filter((a): a is InlineAttachment => a !== null)

      const resetAttachments = hookAttachments.filter(inlineReset)
      if (resetAttachments.length > 0) {
        this.applyReset(messages, resetAttachments)
      }

      this.appendAssistantMessage(messages, reply, lectic)

      const entries = this.getToolCallEntries(reply, registry)

      const realized = await resolveToolCalls(entries, registry, {
        limitExceeded: loopCount > maxToolUse,
        lectic,
        usage,
        runner: opt.hookRunner,
      })

      for (const call of realized) {
        const theTool = call.name in registry ? registry[call.name] : null
        if (!trailingSep) yield "\n\n"
        yield serializeCall(theTool, call)
        yield "\n\n"
        trailingSep = true
      }

      await this.appendToolResults({
        messages,
        final: reply,
        realized,
        hookAttachments: hookAttachments.filter((a) => !inlineReset(a)),
        lectic,
      })
    }
  }
}
