import { LLMProvider, isLLMProvider } from "./provider"
import { Tool } from "./tool"

// TODO Possibly this should be a union type over per-backend interfaces.
export type Interlocutor = {
    prompt : string
    name : string
    provider? : LLMProvider
    tools? : object[]
    registry?: { [key: string] : Tool }
    model? : string
    temperature? : number
    max_tokens? : number
    max_tool_use? : number
    reminder? : string
    nocache? : boolean
}

export function validateInterlocutor(raw : unknown) : raw is Interlocutor {
    if (typeof raw !== "object") {
        throw Error(`Interlocutor needs to be given with at least name and prompt fields. Got ${raw} instead.`)
    } else if (raw === null) {
        throw Error("Something went wrong, got null for interlocutor")
    } else if (!("name" in raw) || typeof raw.name !== "string") {
        throw Error("An interlocutor is missing a name. The name needs to be a string.")
    } else if (!("prompt" in raw) || typeof raw.prompt !== "string") {
        throw Error(`Interlocutor ${raw.name} needs a prompt. The prompt needs to be a string.`)
    } else if (("model" in raw) && typeof raw.model !== "string") {
        throw Error(`The model type for ${raw.name} needs to be a string`)
    } else if (("provider" in raw) && !isLLMProvider(raw.provider)) {
        throw Error(`The provider for ${raw.name} wasn't recognized.`)
    } else if (("max_tokens" in raw) && typeof raw.max_tokens !== "number") {
        // Check for positive natural number...
        throw Error(`The max_tokens for ${raw.name} wasn't well-formed, it needs to be a number.`)
    } else if (("max_tool_use" in raw) && typeof raw.max_tool_use !== "number") {
        // Check for positive natural number...
        throw Error(`The max_tool_use for ${raw.name} wasn't well-formed, it needs to be a number.`)
    } else if (("reminder" in raw) && typeof raw.reminder !== "string") {
        throw Error(`The reminder for ${raw.name} wasn't well-formed, it needs to be a string.`)
    } else if (("nocache" in raw) && typeof raw.nocache!== "boolean") {
        throw Error(`The nocache option for ${raw.name} wasn't well-formed, it needs to be a boolean.`)
    } else if (("temperature" in raw)) {
        if (typeof raw.temperature !== "number") {
            throw Error(`The temperature for ${raw.name} wasn't well-formed, it needs to be a number.`)
        } else if (raw.temperature > 1 || raw.temperature < 0) {
            throw Error(`The temperature for ${raw.name} wasn't well-formed, it needs to between 1 and 0.`)
        }
    } else if (("tools" in raw)) {
        if (!(typeof raw.tools === "object" && raw.tools instanceof Array)) {
            throw Error(`The tools for ${raw.name} need to be given in an array.`)
        } else if (!(raw.tools.every(t => typeof t === "object"))) {
            throw Error(`One or more tools for ${raw.name} weren't properly specified`)
        }
    }
    return true
}
