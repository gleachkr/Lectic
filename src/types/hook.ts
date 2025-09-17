import { execScript, execCmd } from "../utils/exec";
import { expandEnv} from "../utils/replace";
import EventEmitter from 'events'

const hookTypes = [
    "user_message",
    "assistant_message",
    "error"
]

type HookEvents = { 
    user_message : [Record<string,string>] 
    assistant_message : [Record<string,string>] 
    error : [Record<string,string>] 
}

export type HookSpec = {
    on: keyof HookEvents | (keyof HookEvents)[]
    do: string
}

export function validateHookSpec (raw : unknown) : raw is HookSpec {
    if (typeof raw !== "object") {
        throw Error(`Hook needs to be given with at least "on" and "do" fields. Got ${raw} instead.`)
    }
    if (raw === null) {
        throw Error("Something went wrong, got null for hook")
    }
    if (!("on" in raw)) {
        throw Error(`Hook needs to be given with an "on" field.`)
    }
    if (typeof raw.on !== "string" && !Array.isArray(raw.on)) {
        throw Error(`The "on" field of a hook must be a string or array of strings.`)
    }
    if (!("do" in raw) || typeof raw.do !== "string") {
        throw Error(`Hook needs to be given with a "do" field.`)
    }
    if (!(typeof raw.on === "string" ? hookTypes.includes(raw.on) : raw.on.forEach(on => hookTypes.includes(on)))) {
        throw Error(`Hook "on" needs to be one of ${hookTypes.join(", ")}.`)
    }
    return true
}

export class Hook {
    on : (keyof HookEvents)[]
    do : string
    constructor(spec : HookSpec) {
        this.on = typeof spec.on === "string" ? [spec.on] : spec.on
        this.do = spec.do
        this.on.forEach(on => Hook.events.on(on, env => this.run(env)))
    }

    run(env : Record<string, string | undefined> = {}) {
        // need async variants of exec* to make this nonblocking
        this.do.split("\n").length > 1 
            ? execScript(this.do, env)
            : execCmd(expandEnv(this.do), env)
    }

    static events = new EventEmitter<HookEvents>

}

// need to attach at least one handler to error, in order to avoid tripping
// over weird node special-casing of this event name.
Hook.events.on("error", () => {})
