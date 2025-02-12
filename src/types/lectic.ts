import { LLMProvider } from "./provider.ts"

export type Interlocutor = {
    provider : LLMProvider
    model : string
    prompt : string
    name : string
}

export type LecticHeader = {
    interloctor : Interlocutor
}

export type Message = {
    role : string // enum eventually?
    content : string
}

export type LecticBody = {
    messages : Message[];
}

export type Lectic = {
    header : LecticHeader
    body : LecticBody
}
