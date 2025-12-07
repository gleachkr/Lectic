import { execScriptFull, execCmdFull } from "../utils/exec";
import { expandEnv } from "../utils/replace";
import EventEmitter from 'events'
import { Messages } from "../constants/messages"

const hookTypes = [
    "user_message",
    "assistant_message",
    "error",
    "tool_use_pre"
]

export type HookEvents = { 
    user_message : [Record<string,string>] 
    assistant_message : [Record<string,string>] 
    error : [Record<string,string>] 
    tool_use_pre : [Record<string,string>]
}

export type HookSpec = {
    on: keyof HookEvents | (keyof HookEvents)[]
    do: string
    inline?: boolean
}

export function validateHookSpec (raw : unknown) : raw is HookSpec {
    if (typeof raw !== "object") {
        throw Error(Messages.hook.baseNeedsOnDo(raw))
    }
    if (raw === null) {
        throw Error(Messages.hook.baseNull())
    }
    if (!("on" in raw)) {
        throw Error(Messages.hook.onMissing())
    }
    if (typeof raw.on !== "string" && !Array.isArray(raw.on)) {
        throw Error(Messages.hook.onType())
    }
    if (!("do" in raw) || typeof raw.do !== "string") {
        throw Error(Messages.hook.doMissing())
    }
    const validOn = typeof raw.on === "string"
        ? hookTypes.includes(raw.on)
        : raw.on.every(on => hookTypes.includes(on))
    if (!validOn) {
        throw Error(Messages.hook.onValue(hookTypes))
    }
    return true
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
    constructor(spec : HookSpec) {
        this.on = typeof spec.on === "string" ? [spec.on] : spec.on
        this.do = spec.do
        this.inline = spec.inline ?? false
    }

    execute(env : Record<string, string | undefined> = {}, stdin? : string) 
        : { output: string | undefined, exitCode: number } {
        if (this.do.split("\n").length > 1) {
            const result = execScriptFull(this.do, env, stdin ? new Blob([stdin]) : undefined)
            return { output: this.inline ? result.stdout : undefined, exitCode: result.exitCode }
        } else {
            const result = execCmdFull(expandEnv(this.do, env), env, stdin ? new Blob([stdin]) : undefined)
            return { output: this.inline ? result.stdout : undefined, exitCode: result.exitCode }
        }
    }

    static events = new EventEmitter<HookEvents>

}
