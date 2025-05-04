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

export function isInterlocutor(raw : unknown) : raw is Interlocutor  {
    return raw != null &&
        typeof raw === "object" &&
        ("prompt" in raw) &&
        ("name" in raw) &&
        typeof raw.prompt === "string" &&
        typeof raw.name === "string" &&
        (!("model" in raw) || typeof raw.model === "string") &&
        (!("memories" in raw) || isMemories(raw.memories)) &&
        (!("provider" in raw) || isLLMProvider(raw.provider)) &&
        (!("reminder" in raw) || typeof raw.reminder === "string") &&
        (!("tools" in raw) || (typeof raw.tools === "object" 
                               && raw.tools instanceof Array 
                               && raw.tools.every(t => typeof t === "object"))) &&
        (!("temperature" in raw) || (typeof raw.temperature === "number" 
                                     && raw.temperature >= 0 
                                     && raw.temperature <= 1))
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

        // load prompt from file if available
        if (await Bun.file(this.interlocutor.prompt.trim()).exists()) {
            this.interlocutor.prompt = await Bun.file(this.interlocutor.prompt.trim()).text()
        }

        // load memories from file if available
        if (this.interlocutor.memories &&
            typeof this.interlocutor.memories == "string" &&
            await Bun.file(this.interlocutor.memories.trim()).exists()) {
            this.interlocutor.memories = await Bun.file(this.interlocutor.memories.trim()).text()
        }

        if (this.interlocutor.tools) {
            for (const spec of this.interlocutor.tools) {
                // load usage from file if available
                if (isExecToolSpec(spec)) {
                    if (spec.usage && await Bun.file(spec.usage.trim()).exists()) {
                        spec.usage = await Bun.file(spec.usage.trim()).text()
                    }
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
                    throw Error("One or more tools provided were not recognized. Check the tool section of your YAML header.")
                }
            }
        }
    }
}

export function isLecticHeaderSpec(raw: unknown): raw is LecticHeaderSpec {
    return raw !== null &&
        typeof raw === 'object' &&
        (('interlocutor' in raw 
            && isInterlocutor(raw.interlocutor)) ||
         ('interlocutors' in raw 
            && Array.isArray(raw.interlocutors)
            && raw.interlocutors.every(isInterlocutor))
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
