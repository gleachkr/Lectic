import { LLMProvider, isLLMProvider } from "./provider"
import type { Message } from "./message"
import { isMessage } from "./message"
import { isExecToolSpec, ExecTool } from "../tools/exec"
import { isSQLiteToolSpec, SQLiteTool } from "../tools/sqlite"
import { isThinkToolSpec, ThinkTool } from "../tools/think"
import { isMCPSpec, MCPTool } from "../tools/mcp"
import { isServeToolSpec, ServeTool } from "../tools/serve"
import { isNativeTool } from "../tools/native"

type Memories = string | { [key: string] : string }
 
// TODO Possibly this should be a union type over per-backend interfaces.
export type Interlocutor = {
    prompt : string
    name : string
    provider? : LLMProvider
    tools? : object[]
    model? : string
    memories? : Memories
    temperature? : number
    max_tokens? : number
    reminder? : string
}

function isMemories(raw : unknown) : raw is Memories {
    if (typeof raw === "string") {
        return true
    } else if (typeof raw === "object" && raw !== null) {
        for (const [key,val] of Object.entries(raw)) {
            if (typeof key !== "string") return false
            if (typeof val !== "string") return false
        }
        return true
    }
    return false
}

async function maybeFromFile<T>(something: T) : Promise<T | string>{
    if (typeof something === "string" && something.length < 1000) {
        if (await Bun.file(something.trim()).exists()) {
             return await Bun.file(something.trim()).text()
        } else {
            return something
        }
    }
    return something
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
    } else if (("memories" in raw) && !isMemories(raw.memories)) {
        throw Error(`The memories provided for ${raw.name} are not well formed.`)
    } else if (("provider" in raw) && !isLLMProvider(raw.provider)) {
        throw Error(`The provider for ${raw.name} wasn't recognized.`)
    } else if (("max_tokens" in raw) && typeof raw.max_tokens !== "number") {
        // Check for positive natural number...
        throw Error(`The max_tokens for ${raw.name} wasn't well-formed, it needs to be a number.`)
    } else if (("reminder" in raw) && typeof raw.reminder !== "string") {
        throw Error(`The reminder for ${raw.name} wasn't well-formed, it needs to be a string.`)
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

type DialecticHeaderSpec = {
    interlocutor : Interlocutor
}

type ManylecticHeaderSpec = {
    interlocutors : [ Interlocutor, ...Interlocutor[] ]
}

type LecticHeaderSpec = DialecticHeaderSpec | ManylecticHeaderSpec

export class LecticHeader {
    interlocutor : Interlocutor
    interlocutors : Interlocutor[]
    constructor(spec : LecticHeaderSpec) {
        if ("interlocutor" in spec) {
            this.interlocutor = spec.interlocutor
            this.interlocutors = [spec.interlocutor]
        } else {
            this.interlocutor = spec.interlocutors[0]
            this.interlocutors = spec.interlocutors
        }
    }

    setSpeaker(name : string) {
        const newSpeaker = this.interlocutors.find(inter => inter.name === name)
        if (newSpeaker) {
            this.interlocutor = newSpeaker
        } else {
            throw Error(`There's not an interlocutor named ${name}`)
        }
    }


    async initialize() {
        // TODO DRY the "load from file" pattern

        this.interlocutor.prompt = await maybeFromFile(this.interlocutor.prompt)

        this.interlocutor.memories = await maybeFromFile(this.interlocutor.memories)

        if (this.interlocutor.tools) {
            for (const spec of this.interlocutor.tools) {
                // load usage from file if available
                if (isExecToolSpec(spec)) {
                    spec.usage = await maybeFromFile(spec.usage)
                    new ExecTool(spec)
                } else if (isSQLiteToolSpec(spec)) {
                    new SQLiteTool(spec)
                } else if (isThinkToolSpec(spec)) {
                    new ThinkTool(spec)
                } else if (isServeToolSpec(spec)) {
                    new ServeTool(spec)
                } else if (isMCPSpec(spec)) {
                    await MCPTool.fromSpec(spec)
                } else if (isNativeTool(spec)) {
                    //XXX Handle this per-backend
                } else {
                    throw Error(`The tool provided by ${JSON.stringify(spec)} wasn't recognized.` +
                                `Check the tool section of your YAML header.`)
                }
            }
        }
    }
}

export function validateLecticHeaderSpec(raw : unknown) : raw is LecticHeaderSpec {
    return raw !== null &&
        typeof raw === 'object' &&
        (('interlocutor' in raw 
            && validateInterlocutor(raw.interlocutor)) ||
         ('interlocutors' in raw 
            && Array.isArray(raw.interlocutors)
            && raw.interlocutors.every(validateInterlocutor))
        )
}

export type LecticBody = {
    messages : Message[];
}

export function isLecticBody(raw: unknown): raw is LecticBody {
    return raw !== null &&
        typeof raw === 'object' &&
        'messages' in raw &&
        Array.isArray(raw.messages) &&
        raw.messages.every(isMessage);
}

export type Lectic = {
    header : LecticHeader
    body : LecticBody
}

export function isLectic(raw: unknown): raw is Lectic {
    return raw !== null &&
        typeof raw === 'object' &&
        'header' in raw &&
        'body' in raw &&
        (raw.header instanceof LecticHeader) &&
        isLecticBody(raw.body);
}
