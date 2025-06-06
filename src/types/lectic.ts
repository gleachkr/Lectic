import type { Message } from "./message"
import type { Interlocutor } from "./interlocutor"
import { validateInterlocutor } from "./interlocutor"
import { isMessage } from "./message"
import { isExecToolSpec, ExecTool } from "../tools/exec"
import { isSQLiteToolSpec, SQLiteTool } from "../tools/sqlite"
import { isThinkToolSpec, ThinkTool } from "../tools/think"
import { isMCPSpec, MCPTool } from "../tools/mcp"
import { isServeToolSpec, ServeTool } from "../tools/serve"
import { isNativeTool } from "../tools/native"

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
