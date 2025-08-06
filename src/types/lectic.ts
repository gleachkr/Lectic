import type { Message } from "./message"
import { Tool } from "./tool"
import { validateInterlocutor, type Interlocutor } from "./interlocutor"
import { validateMacroSpec, Macro, type MacroSpec } from "./macro"
import { isMessage } from "./message"
import { isExecToolSpec, ExecTool } from "../tools/exec"
import { isSQLiteToolSpec, SQLiteTool } from "../tools/sqlite"
import { isThinkToolSpec, ThinkTool } from "../tools/think"
import { isMCPSpec, MCPTool } from "../tools/mcp"
import { isServeToolSpec, ServeTool } from "../tools/serve"
import { isAgentToolSpec, AgentTool } from "../tools/agent"
import { isNativeTool } from "../tools/native"
import { loadFrom } from "../utils/loader"
import { mergeValues } from "../utils/merge"

type DialecticHeaderSpec = {
    interlocutor : Interlocutor
    interlocutors? : [ ...Interlocutor[] ]
    macros?: MacroSpec[]
}

type ManylecticHeaderSpec = {
    interlocutors : [ Interlocutor, ...Interlocutor[] ]
    macros?: MacroSpec[]
}

type LecticHeaderSpec = DialecticHeaderSpec | ManylecticHeaderSpec

export class LecticHeader {
    interlocutor : Interlocutor
    interlocutors : Interlocutor[]
    macros: Macro[]
    constructor(spec : LecticHeaderSpec) {
        if ("interlocutor" in spec) {
            // We have some extra logic here to merge two entries if the
            // interlocutor appears in the interlocutors list as well.
            const maybeExists = spec.interlocutors?.find(inter => inter.name == spec.interlocutor.name)
            this.interlocutor = maybeExists 
                ? mergeValues(maybeExists, spec.interlocutor)
                : this.interlocutor = spec.interlocutor
            this.interlocutors = maybeExists
                ? [this.interlocutor, ... (spec.interlocutors?.filter(i => i.name !== maybeExists.name) ?? [])]
                : [this.interlocutor, ... (spec.interlocutors ?? [])]
        } else {
            this.interlocutor = spec.interlocutors[0]
            this.interlocutors = spec.interlocutors
        }
        this.macros = (spec.macros ?? []).map(spec => new Macro(spec))
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
        for (const interlocutor of this.interlocutors) {
            interlocutor.prompt = await loadFrom(interlocutor.prompt)

            interlocutor.registry = {}

            if (interlocutor.tools) {
                for (const spec of interlocutor.tools) {
                    // TODO it'd be nice to just have the tools save their
                    // registration boilerplate on to Tool as each class is defined
                    const register = (tool : Tool) => {
                        if (interlocutor.registry === undefined) return
                        if (tool.name in interlocutor.registry) {
                            throw Error(`the name ${tool.name} is being used twice. Each tool needs a unique name`)
                        } else {
                            interlocutor.registry[tool.name] = tool 
                        }
                    }
                    if (isExecToolSpec(spec)) {
                        spec.usage = await loadFrom(spec.usage)
                        register(new ExecTool(spec))
                    } else if (isSQLiteToolSpec(spec)) {
                        spec.details = await loadFrom(spec.details)
                        register(new SQLiteTool(spec))
                    } else if (isThinkToolSpec(spec)) {
                        register(new ThinkTool(spec))
                    } else if (isServeToolSpec(spec)) {
                        register(new ServeTool(spec))
                    } else if (isAgentToolSpec(spec)) {
                        spec.usage = await loadFrom(spec.usage)
                        register(new AgentTool(spec, this.interlocutors))
                    } else if (isMCPSpec(spec)) {
                        (await MCPTool.fromSpec(spec)).map(register)
                    } else if (isNativeTool(spec)) {
                       // do nothing 
                    } else {
                        throw Error(`The tool provided by ${JSON.stringify(spec)} wasn't recognized.` +
                                    `Check the tool section of your YAML header.`)
                    }
                }
            }
        }
    }
}

export function validateLecticHeaderSpec(raw : unknown) : raw is LecticHeaderSpec {
    return raw !== null &&
        typeof raw === 'object' &&
        (('interlocutor' in raw 
            && validateInterlocutor(raw.interlocutor)
            && ('interlocutors' in raw 
                ? Array.isArray(raw.interlocutors) && raw.interlocutors.every(validateInterlocutor)
                : true
               )
         ) ||
         ('interlocutors' in raw 
            && Array.isArray(raw.interlocutors)
            && raw.interlocutors.length !== 0
            && raw.interlocutors.every(validateInterlocutor))
        ) && ('macros' in raw
                ? Array.isArray(raw.macros) && raw.macros.every(validateMacroSpec)
                : true
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
