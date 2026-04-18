import {
    execScriptFull,
    execCmdFull,
    execScriptBackground,
    execCmdBackground,
    execScriptDetached,
    execCmdDetached,
} from "../utils/exec";
import { expandEnv } from "../utils/replace";
import EventEmitter from 'events'
import { Messages } from "../constants/messages"

export type HookEvents = {
    user_message : [Record<string,string>]
    user_first : [Record<string,string>]
    assistant_message : [Record<string,string>]
    assistant_final : [Record<string,string>]
    assistant_intermediate : [Record<string,string>]
    error : [Record<string,string>]
    tool_use_pre : [Record<string,string>]
    tool_use_post : [Record<string,string>]
    run_start : [Record<string,string>]
    run_end : [Record<string,string>]
}

export const HOOK_EVENT_TYPES: (keyof HookEvents)[] = [
    "user_message",
    "user_first",
    "assistant_message",
    "assistant_final",
    "assistant_intermediate",
    "error",
    "tool_use_pre",
    "tool_use_post",
    "run_start",
    "run_end",
]

export type HookInlineMode = "attachment" | "comment"
export type HookMode = "sync" | "background" | "detached"

export type HookSpec = {
    on: keyof HookEvents | (keyof HookEvents)[]
    do: string
    inline?: boolean
    inline_as?: HookInlineMode
    name?: string
    icon?: string
    allow_failure?: boolean
    mode?: HookMode
    env?: Record<string, string>
}

function isHookEventName(v: unknown): v is keyof HookEvents {
    return typeof v === "string"
        && HOOK_EVENT_TYPES.includes(v as keyof HookEvents)
}

function isHookMode(v: unknown): v is HookMode {
    return v === "sync" || v === "background" || v === "detached"
}

export function validateHookSpec (raw : unknown) : raw is HookSpec {
    if (typeof raw !== "object") {
        throw Error(Messages.hook.baseNeedsOnDo(raw))
    }
    if (raw === null) {
        throw Error(Messages.hook.baseNull())
    }
    const hook = raw as Record<string, unknown>
    if (!("on" in raw)) {
        throw Error(Messages.hook.onMissing())
    }
    if (typeof raw.on !== "string" && !Array.isArray(raw.on)) {
        throw Error(Messages.hook.onType())
    }
    if (!("do" in raw) || typeof raw.do !== "string") {
        throw Error(Messages.hook.doMissing())
    }
    if ("name" in raw && typeof raw.name !== "string") {
        throw Error(Messages.hook.nameType())
    }
    if ("icon" in raw && typeof raw.icon !== "string") {
        throw Error(Messages.hook.iconType())
    }
    if (
        "inline_as" in raw &&
        raw.inline_as !== "attachment" &&
        raw.inline_as !== "comment"
    ) {
        throw Error(Messages.hook.inlineAsType())
    }
    if ("env" in raw && (typeof raw.env !== "object" || raw.env === null)) {
        throw Error(Messages.hook.envType())
    }
    if ("allow_failure" in raw && typeof raw.allow_failure !== "boolean") {
        throw Error(Messages.hook.allowFailureType())
    }
    if ("mode" in raw && !isHookMode(raw.mode)) {
        throw Error(Messages.hook.modeType())
    }
    const validOn = typeof raw.on === "string"
        ? isHookEventName(raw.on)
        : raw.on.every(isHookEventName)
    if (!validOn) {
        throw Error(Messages.hook.onValue(HOOK_EVENT_TYPES))
    }
    if ((hook["mode"] ?? "sync") !== "sync" && hook["inline"] === true) {
        throw Error(Messages.hook.modeInline())
    }
    return true
}

function resolveHookDispatchOrder(
    event: keyof HookEvents,
    env: Record<string, string | undefined>
): (keyof HookEvents)[] {
    if (event === "assistant_message") {
        const toolUseDone = env["TOOL_USE_DONE"] === "1"
        if (toolUseDone) {
            return ["assistant_message", "assistant_final"]
        }
        return ["assistant_message", "assistant_intermediate"]
    }

    if (event === "user_message") {
        const firstMessage = env["MESSAGES_LENGTH"] === "1"
        if (firstMessage) {
            return ["user_message", "user_first"]
        }
        return ["user_message"]
    }

    if (event === "run_end" && env["RUN_STATUS"] === "error") {
        return ["run_end", "error"]
    }

    return [event]
}

export function getActiveHooks(
    hooks: Hook[],
    event: keyof HookEvents,
    env: Record<string, string | undefined> = {}
): Hook[] {
    const orderedEvents = resolveHookDispatchOrder(event, env)
    const active: Hook[] = []
    for (const ev of orderedEvents) {
        active.push(...hooks.filter((h) => h.on.includes(ev)))
    }
    return active
}

export function isHookSpec(raw : unknown) : raw is HookSpec {
    try {
        return validateHookSpec(raw)
    } catch {
        return false
    }
}

export function isHookSpecList(raw: unknown): raw is HookSpec[] {
    return Array.isArray(raw) && raw.every(isHookSpec)
}

export class Hook {
    on : (keyof HookEvents)[]
    do : string
    inline : boolean
    name? : string
    icon? : string
    inline_as : HookInlineMode
    allow_failure : boolean
    mode : HookMode
    env : Record<string, string>

    constructor(spec : HookSpec) {
        validateHookSpec(spec)
        this.on = typeof spec.on === "string" ? [spec.on] : spec.on
        this.do = spec.do
        this.inline = spec.inline ?? false
        this.inline_as = spec.inline_as ?? "attachment"
        this.name = spec.name
        this.icon = spec.icon
        this.allow_failure = spec.allow_failure ?? false
        this.mode = spec.mode ?? "sync"
        this.env = spec.env || {}
    }

    execute(env : Record<string, string | undefined> = {}, stdin? : string)
        : { output: string | undefined, stderr: string, exitCode: number } {
        const mergedEnv = { ...this.env, ...env }
        if (this.do.split("\n").length > 1) {
            const result = execScriptFull(
                this.do,
                mergedEnv,
                stdin ? new Blob([stdin]) : undefined
            )
            return {
                output: this.inline ? result.stdout : undefined,
                stderr: result.stderr,
                exitCode: result.exitCode,
            }
        } else {
            const result = execCmdFull(
                expandEnv(this.do, mergedEnv),
                mergedEnv,
                stdin ? new Blob([stdin]) : undefined
            )
            return {
                output: this.inline ? result.stdout : undefined,
                stderr: result.stderr,
                exitCode: result.exitCode,
            }
        }
    }

    executeBackground(
        env : Record<string, string | undefined> = {},
        stdin? : string
    ) : Promise<number> {
        const mergedEnv = { ...this.env, ...env }
        if (this.do.split("\n").length > 1) {
            return execScriptBackground(
                this.do,
                mergedEnv,
                stdin ? new Blob([stdin]) : undefined
            )
        }

        return execCmdBackground(
            expandEnv(this.do, mergedEnv),
            mergedEnv,
            stdin ? new Blob([stdin]) : undefined
        )
    }

    executeDetached(
        env : Record<string, string | undefined> = {},
        stdin? : string
    ) : Promise<number> {
        const mergedEnv = { ...this.env, ...env }
        if (this.do.split("\n").length > 1) {
            return execScriptDetached(
                this.do,
                mergedEnv,
                stdin ? new Blob([stdin]) : undefined
            )
        }

        return execCmdDetached(
            expandEnv(this.do, mergedEnv),
            mergedEnv,
            stdin ? new Blob([stdin]) : undefined
        )
    }

    static events = new EventEmitter<HookEvents>

}
