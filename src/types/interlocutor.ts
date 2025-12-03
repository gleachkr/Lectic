import { LLMProvider, isLLMProvider } from "./provider"
import { Tool } from "./tool"
import { type HookSpec, type Hook, isHookSpecList } from "./hook"
import { Messages } from "../constants/messages"

// TODO Possibly this should be a union type over per-backend interfaces.
export type Interlocutor = {
    prompt : string
    name : string
    provider? : LLMProvider
    tools? : object[]
    registry?: Record<string, Tool>
    model? : string
    temperature? : number
    max_tokens? : number
    max_tool_use? : number
    reminder? : string
    nocache? : boolean
    hooks? : HookSpec[]
    active_hooks?: Hook[]
    thinking_budget?: number
    thinking_effort?: "none" | "low" | "medium" | "high"
}

export function validateInterlocutor(raw : unknown) : raw is Interlocutor {
    if (typeof raw !== "object") {
        throw Error(Messages.interlocutor.baseNeedsNamePrompt(raw))
    } 
    if (raw === null) {
        throw Error(Messages.interlocutor.baseNull())
    } 
    if (!("name" in raw) || typeof raw.name !== "string") {
        throw Error(Messages.interlocutor.nameMissing())
    } 
    if (!("prompt" in raw) || typeof raw.prompt !== "string") {
        const name = typeof raw?.name === "string" ? raw.name : "<unknown>"
        throw Error(Messages.interlocutor.promptMissing(name))
    } 
    if (("model" in raw) && typeof raw.model !== "string") {
        throw Error(Messages.interlocutor.modelType(raw.name))
    } 
    if (("provider" in raw) && !isLLMProvider(raw.provider)) {
        throw Error(Messages.interlocutor.providerEnum(raw.name))
    } 
    if (("max_tokens" in raw) && typeof raw.max_tokens !== "number") {
        throw Error(Messages.interlocutor.maxTokensType(raw.name))
    } 
    if (("max_tool_use" in raw) && typeof raw.max_tool_use !== "number") {
        throw Error(Messages.interlocutor.maxToolUseType(raw.name))
    } 
    if (("reminder" in raw) && typeof raw.reminder !== "string") {
        throw Error(Messages.interlocutor.reminderType(raw.name))
    } 
    if (("nocache" in raw) && typeof raw.nocache!== "boolean") {
        throw Error(Messages.interlocutor.nocacheType(raw.name))
    } 
    if (("thinking_budget" in raw) && !Number.isInteger(raw.thinking_budget)) {
        throw Error(Messages.interlocutor.thinkingBudgetType(raw.name))
    } 
    if (("thinking_effort" in raw) && 
        (raw.thinking_effort !== "none") &&
        (raw.thinking_effort !== "low") &&
        (raw.thinking_effort !== "medium") &&
        (raw.thinking_effort !== "high")) {
        throw Error(Messages.interlocutor.thinkingEffortType(raw.name))
    } 
    if (("temperature" in raw)) {
        if (typeof raw.temperature !== "number") {
            throw Error(Messages.interlocutor.temperatureType(raw.name))
        } else if (raw.temperature > 1 || raw.temperature < 0) {
            throw Error(Messages.interlocutor.temperatureRange(raw.name))
        }
    } 
    if (("tools" in raw)) {
        if (!(typeof raw.tools === "object" && raw.tools instanceof Array)) {
            throw Error(Messages.interlocutor.toolsType(raw.name))
        } else if (!(raw.tools.every(t => typeof t === "object"))) {
            throw Error(Messages.interlocutor.toolsItems(raw.name))
        }
    }
    if (("hooks" in raw)) {
        if (!Array.isArray(raw.hooks)) {
            throw Error(Messages.interlocutor.hooksType(raw.name))
        } else if (!isHookSpecList(raw.hooks)) {
            throw Error(Messages.interlocutor.hooksItems(raw.name))
        }
    }
    return true
}
