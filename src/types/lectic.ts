import { LLMProvider, isLLMProvider } from "./provider"
import type { Message } from "./message"
import { isMessage } from "./message"

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
        const newSpeaker = this.interlocutors.find(inter => inter.name = name)
        if (newSpeaker) {
            this.interlocutor = newSpeaker
        } else {
            throw Error(`There's not an interlocutor named ${name}`)
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
