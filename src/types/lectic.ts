import type { Message } from "./message"
import * as YAML from "yaml"
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
            const maybeExists = spec.interlocutors?.find(inter => inter.name == spec.interlocutor.name)
            this.interlocutor =  spec.interlocutor
            this.interlocutors = maybeExists
                ? [this.interlocutor, ... (spec.interlocutors?.filter(i => i.name !== maybeExists.name) ?? [])]
                : [this.interlocutor, ... (spec.interlocutors ?? [])]
        } else {
            this.interlocutor = spec.interlocutors[0]
            this.interlocutors = spec.interlocutors
        }
        this.macros = (spec.macros ?? []).map(spec => new Macro(spec))
    }

    static mergeInterlocutorSpecs(yamls : (string | null)[]) {

        const raw = yamls.filter(x => x !== null)
            .map(h => YAML.parse(h))
            .reduce(mergeValues)
        // We have some extra logic here to merge two entries if the
        // interlocutor appears in the interlocutors list as well.
        if (typeof raw === "object" && raw !== null &&
            "interlocutor" in raw && typeof raw.interlocutor === "object" && raw.interlocutor !== null &&
            "interlocutors" in raw && Array.isArray(raw.interlocutors)) {
            const theName = "name" in raw.interlocutor ? raw.interlocutor.name : undefined
            const maybeExists = raw.interlocutors?.find((inter : unknown) => 
                typeof inter === "object" && inter !== null && "name" in inter && inter.name === theName)
            if (maybeExists) raw.interlocutor = mergeValues(maybeExists, raw.interlocutor)
        }
        return raw
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
                        // don't mutate spec, it's confusing elsewhere if the
                        // tool spece starts to not match the YAML, for example
                        // if the YAML uses &* references
                        const loadedSpec = { ...spec }
                        loadedSpec.usage = await loadFrom(spec.usage)
                        register(new ExecTool(loadedSpec, interlocutor.name))
                    } else if (isSQLiteToolSpec(spec)) {
                        spec.details = await loadFrom(spec.details)
                        register(new SQLiteTool(spec))
                    } else if (isThinkToolSpec(spec)) {
                        register(new ThinkTool(spec))
                    } else if (isServeToolSpec(spec)) {
                        register(new ServeTool(spec))
                    } else if (isAgentToolSpec(spec)) {
                        const loadedSpec = { ...spec }
                        loadedSpec.usage = await loadFrom(spec.usage)
                        register(new AgentTool(loadedSpec, this.interlocutors))
                    } else if (isMCPSpec(spec)) {
                        (await MCPTool.fromSpec(spec)).map(register)
                    } else if (isNativeTool(spec)) {
                       // do nothing 
                    } else {
                        throw Error(`The tool provided by ${JSON.stringify(spec)} wasn't recognized. ` +
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

export class Lectic {
    header : LecticHeader
    body : LecticBody
    constructor({ header, body } : {header : LecticHeader, body : LecticBody }) {
        this.header = header
        this.body = body
    }

    handleDirectives() {
        const messages = this.body.messages
        for (const message of messages) {
            if (message.role === "user") {
                for (const directive of message.containedDirectives()) {
                    if (directive.name === "ask") {
                        this.header.setSpeaker(directive.text)
                    }
                }
            }
        }
        if (messages.length > 0) {
            const message = messages[messages.length -1 ]
            if (message.role === "user") {
                for (const directive of message.containedDirectives()) {
                    if (directive.name === "aside") {
                        this.header.setSpeaker(directive.text)
                    }
                }
            }
        }
    }
}

export function isLectic(raw: unknown): raw is Lectic {
    return raw !== null &&
        typeof raw === 'object' &&
        'header' in raw &&
        'body' in raw &&
        (raw.header instanceof LecticHeader) &&
        isLecticBody(raw.body);
}
