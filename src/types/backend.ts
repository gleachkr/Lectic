import { Logger } from "../logging/logger"
import { Lectic, type HasModel } from "./lectic"
import { type Message, UserMessage } from "./message"
import { Hook, type HookEvents } from "./hook"
import { serializeCall, ToolCallResults, type Tool, type ToolCall} from "./tool"
import { LLMProvider } from "./provider"
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

export function runHooks(
  hooks: Hook[],
  event: keyof HookEvents,
  env: Record<string, string>,
  stdin?: string
): InlineAttachment[] {
  const inline: InlineAttachment[] = []

  const active = hooks.filter((h) => h.on.includes(event))

  for (const hook of active) {
    try {
      const { output } = hook.execute(env, stdin)
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

  const allHooks = lectic.header.hooks.concat(
    lectic.header.interlocutor.active_hooks ?? []
  )

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

  const allHooks = lectic.header.hooks.concat(
    lectic.header.interlocutor.active_hooks ?? []
  )

  return runHooks(allHooks, "user_message", baseEnv)
}

export function emitInlineAttachments(msg: UserMessage): InlineAttachment[] {
  // These are the attachments generated during macro expansion
  return msg.inlineAttachments
}

export type ToolRegistry = Record<string, Tool>

export type ToolCallEntry = { id?: string; name: string; args: unknown }

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

  const results: ToolCall[] = await Promise.all(entries.map(async entry => {
    const id = entry.id
    const name = entry.name
    const args = entry.args

    if (!isObjectRecord(args)) {
      return { name, args: {}, id,
        isError: true,
        results: ToolCallResults(invalidArgsMsg),
      }
    }

    if (opt?.limitExceeded) {
      return { name, args, id,
        isError: true,
        results: ToolCallResults(limitMsg),
      }
    }

    if (!(name in registry)) {
      return { name, args, id,
        isError: true,
        results: ToolCallResults(`Unrecognized tool name: ${name}`),
      }
    }

    try {
      const hooks = [
        ...globalHooks,
        ...interlocutorHooks,
        ...registry[name].hooks,
      ]

      const activeHooks = hooks.filter((h) => h.on.includes("tool_use_pre"))
      for (const hook of activeHooks) {
        const hookEnv: Record<string, string> = {
          TOOL_NAME: name,
          TOOL_ARGS: JSON.stringify(args),
        }

        if (opt?.usage) {
          hookEnv["TOKEN_USAGE_INPUT"] = String(opt.usage.input)
          hookEnv["TOKEN_USAGE_OUTPUT"] = String(opt.usage.output)
          hookEnv["TOKEN_USAGE_TOTAL"] = String(opt.usage.total)
          hookEnv["TOKEN_USAGE_CACHED"] = String(opt.usage.cached)
        }

        const { exitCode } = hook.execute(hookEnv)
        if (exitCode !== 0) throw new Error("Tool use permission denied")
      }

      const toolResults = await registry[name].call(args)
      return { name, args, id, 
        isError: false, 
        results: toolResults 
      }
    } catch (e) {
      const msg = e instanceof Error
        ? e.message
        : `An error of unknown type occurred during a call to ${name}`
      return { name, args, id,
        isError: true,
        results: ToolCallResults(msg),
      }
    }
  }))

  return results
}

export type BackendCompletion<TFinal> = {
  text: AsyncIterable<string>
  final: Promise<TFinal>
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

  async *evaluate(lectic: Lectic): AsyncIterable<string | Message> {
    const messages: TMessage[] = []

    // Only execute :cmd directives and user_message hooks if the last
    // message is a user message.
    const lastIdx = lectic.body.messages.length - 1
    const lastIsUser =
      lastIdx >= 0 && lectic.body.messages[lastIdx].role === "user"

    let inlinePreface: InlineAttachment[] = []

    for (let i = 0; i < lectic.body.messages.length; i++) {
      const m = lectic.body.messages[i]

      if (m.role === "user" && lastIsUser && i === lastIdx) {
        const cleanMsg = m.cleanSideEffects()
        const hookAttachments = emitUserMessageEvent(m.content, lectic)
        const directiveAttachments = emitInlineAttachments(m)

        // XXX: Make sure to keep transcript order aligned with the
        // provider-visible order. This prevents the initial request from
        // seeing a different ordering than subsequent runs that replay cached
        // inline attachments.
        inlinePreface = [...hookAttachments, ...directiveAttachments]

        const { messages: newMsgs } = await this.handleMessage(cleanMsg, lectic, {
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
    })
  }

  protected async *runConversationLoop(opt: {
    messages: TMessage[]
    lectic: Lectic & HasModel
    inlinePreface: InlineAttachment[]
  }): AsyncGenerator<string | Message> {
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
