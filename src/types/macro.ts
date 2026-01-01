import { loadFrom } from "../utils/loader"
import { expandEnv } from "../utils/replace"
import { Messages } from "../constants/messages"

export type MacroSpec = {
    name: string
    expansion?: string
    pre?: string
    post?: string
    env?: Record<string, string>
}

export function validateMacroSpec (raw : unknown) : raw is MacroSpec {
    if (typeof raw !== "object") {
        throw Error(Messages.macro.baseNeedsNameExpansion(raw))
    }
    if (raw === null) {
        throw Error(Messages.macro.baseNull())
    }
    if (!("name" in raw) || (typeof raw.name !== "string")) {
        throw Error(Messages.macro.nameMissing())
    }
    const hasExpansion = "expansion" in raw && typeof raw.expansion === "string";
    const hasPre = "pre" in raw && typeof raw.pre === "string";
    const hasPost = "post" in raw && typeof raw.post === "string";

    if ("env" in raw && (typeof raw.env !== "object" || raw.env === null)) {
        throw Error(Messages.macro.envType())
    }

    if (!hasExpansion && !hasPre && !hasPost) {
        throw Error(Messages.macro.expansionMissing())
    }
    return true
}

export class Macro {
    name : string
    pre? : string
    post? : string
    env : Record<string, string>

    constructor({name, expansion, pre, post, env} : MacroSpec) {
        this.name = name
        this.pre = pre
        this.post = post || expansion
        this.env = env || {}
    }

    get expansion() : string {
        return this.post || ""
    }

    async expandPre(env : Record<string, string | undefined> = {}) : Promise<string | undefined> {
        const mergedEnv = { ...this.env, ...env }
        if (!this.pre) return undefined
        const loaded = await loadFrom(this.pre, mergedEnv)
        if (typeof loaded === "string") {
            const result = expandEnv(loaded, mergedEnv)
            // Empty string means "fallthrough" / "do nothing"
            return result === "" ? undefined : result
        }
        return undefined
    }

    async expandPost(env : Record<string, string | undefined> = {}) : Promise<string | undefined> {
        const mergedEnv = { ...this.env, ...env }
        if (!this.post) return undefined
        const loaded = await loadFrom(this.post, mergedEnv)
        return typeof loaded === "string" ? expandEnv(loaded, mergedEnv) : undefined
    }
}
