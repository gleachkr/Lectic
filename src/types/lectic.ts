import { LLMProvider, isLLMProvider } from "./provider.ts"

export type Interlocutor = {
    provider? : LLMProvider
    model? : string
    prompt : string
    name : string
}

export function isInterlocutor(raw : unknown) : raw is Interlocutor  {
    return raw != null &&
        typeof raw == "object" &&
        ("prompt" in raw) &&
        ("name" in raw) &&
        typeof raw.prompt == "string" &&
        typeof raw.name == "string" &&
        (("model" in raw) ? typeof raw.model == "string" : true) &&
        (("provider" in raw) ? isLLMProvider(raw.provider) : true)
}


export type LecticHeader = {
    interlocutor : Interlocutor
}

export function isLecticHeader(raw: any): raw is LecticHeader {
    return raw != null &&
        typeof raw === 'object' &&
        'interlocutor' in raw &&
        isInterlocutor(raw.interlocutor);
}

export type Message = {
    role : "user" | "assistant" // openAI will require "tool" eventually?
    content : string
}

export function isMessage(raw: any): raw is Message {
    return raw != null &&
        typeof raw === 'object' &&
        'role' in raw &&
        'content' in raw &&
        typeof raw.role === 'string' &&
        typeof raw.content === 'string';
}

export type LecticBody = {
    messages : Message[];
}

export function isLecticBody(raw: any): raw is LecticBody {
    return raw != null &&
        typeof raw === 'object' &&
        'messages' in raw &&
        Array.isArray(raw.messages) &&
        raw.messages.every(isMessage);
}

export type Lectic = {
    header : LecticHeader
    body : LecticBody
}

export function isLectic(raw: any): raw is Lectic {
    return raw != null &&
        typeof raw === 'object' &&
        'header' in raw &&
        'body' in raw &&
        isLecticHeader(raw.header) &&
        isLecticBody(raw.body);
}
