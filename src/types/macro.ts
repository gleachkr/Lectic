import { loadFrom } from "../utils/loader"
import { expandEnv } from "../utils/replace"
import { Messages } from "../constants/messages"

export type MacroCompletionTrigger = "auto" | "manual"

export type MacroCompletionItem = {
    completion: string
    detail?: string
    documentation?: string
}

export type MacroCompletionsSpec = MacroCompletionItem[] | string

export type MacroSpec = {
    name: string
    expansion?: string
    pre?: string
    post?: string
    env?: Record<string, string>
    description?: string
    completions?: MacroCompletionsSpec
    completion_trigger?: MacroCompletionTrigger
}

function isMacroCompletionItem(raw: unknown): raw is MacroCompletionItem {
    if (typeof raw !== "object" || raw === null) {
        throw Error(Messages.macro.completionItemType())
    }

    const entry = raw as Record<string, unknown>
    if (typeof entry["completion"] !== "string") {
        throw Error(Messages.macro.completionItemType())
    }

    if ("detail" in entry && typeof entry["detail"] !== "string") {
        throw Error(Messages.macro.completionItemDetailType())
    }

    if (
        "documentation" in entry
        && typeof entry["documentation"] !== "string"
    ) {
        throw Error(Messages.macro.completionItemDocumentationType())
    }

    return true
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

    if ("description" in raw && typeof raw.description !== "string") {
        throw Error(Messages.macro.descriptionType())
    }

    if ("completions" in raw) {
        const completions = raw.completions
        if (typeof completions === "string") {
            const trimmed = completions.trimStart()
            const isFileSource = trimmed.startsWith("file:")
            const isExecSource = trimmed.startsWith("exec:")
            if (!isFileSource && !isExecSource) {
                throw Error(Messages.macro.completionSourceType())
            }
        } else if (Array.isArray(completions)) {
            completions.every(isMacroCompletionItem)
        } else {
            throw Error(Messages.macro.completionsType())
        }
    }

    if ("completion_trigger" in raw) {
        const trigger = raw.completion_trigger
        if (trigger !== "auto" && trigger !== "manual") {
            throw Error(Messages.macro.completionTriggerType())
        }
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
    description? : string
    completions? : MacroCompletionsSpec
    completionTrigger? : MacroCompletionTrigger

    constructor({
        name,
        expansion,
        pre,
        post,
        env,
        description,
        completions,
        completion_trigger,
    } : MacroSpec) {
        this.name = name
        this.pre = pre
        this.post = post || expansion
        this.env = env || {}
        this.description = description
        this.completions = completions
        this.completionTrigger = completion_trigger
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
