import { LLMProvider, isLLMProvider } from "./provider"
import type { ToolSpec } from "./tool_spec"
import { isToolSpec } from "./tool_spec"
import { Message } from "./message"
 
// TODO Possibly this should be a union type over per-backend interfaces.
export type Interlocutor = {
    prompt : string
    name : string
    provider? : LLMProvider
    tools? : ToolSpec[]
    model? : string
    memories? : string
    temperature? : number
    max_tokens? : number
}

export function isInterlocutor(raw : unknown) : raw is Interlocutor  {
    return raw != null &&
        typeof raw === "object" &&
        ("prompt" in raw) &&
        ("name" in raw) &&
        typeof raw.prompt === "string" &&
        typeof raw.name === "string" &&
        (("model" in raw) ? typeof raw.model === "string" : true) &&
        (("memories" in raw) ? typeof raw.memories === "string" : true) &&
        (("provider" in raw) ? isLLMProvider(raw.provider) : true) &&
        (("tools" in raw) ? typeof raw.tools === "object" 
            && raw.tools instanceof Array && raw.tools.every(isToolSpec) : true) &&
        (("temperature" in raw) ? typeof raw.temperature === "number" 
            && raw.temperature >= 0 && raw.temperature <= 1 : true)
}


export type LecticHeader = {
    interlocutor : Interlocutor
}

export function isLecticHeader(raw: unknown): raw is LecticHeader {
    return raw !== null &&
        typeof raw === 'object' &&
        'interlocutor' in raw &&
        isInterlocutor(raw.interlocutor);
}

export type LecticBody = {
    messages : Message[];
}

export function isLecticBody(raw: unknown): raw is LecticBody {
    return raw !== null &&
        typeof raw === 'object' &&
        'messages' in raw &&
        Array.isArray(raw.messages) &&
        raw.messages.every(m => m instanceof Message);
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
        isLecticHeader(raw.header) &&
        isLecticBody(raw.body);
}
