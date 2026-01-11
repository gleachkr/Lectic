import type { Message } from "./message"
import * as YAML from "yaml"
import { Tool } from "./tool"
import { validateInterlocutor, type Interlocutor } from "./interlocutor"
import { validateMacroSpec, Macro, type MacroSpec } from "./macro"
import { validateHookSpec, Hook, type HookSpec } from "./hook"
import { isMessage, UserMessage } from "./message"
import { isExecToolSpec, ExecTool, type ExecToolSpec } from "../tools/exec"
import { isSQLiteToolSpec, SQLiteTool, type SQLiteToolSpec } from "../tools/sqlite"
import { isThinkToolSpec, ThinkTool } from "../tools/think"
import { isMCPSpec, MCPTool } from "../tools/mcp"
import { isServeToolSpec, ServeTool } from "../tools/serve"
import { isAgentToolSpec, AgentTool, type AgentToolSpec } from "../tools/agent"
import { isNativeTool } from "../tools/native"
import { loadFrom } from "../utils/loader"
import { mergeValues } from "../utils/merge"
import { Messages } from "../constants/messages"
import { isObjectRecord } from "./guards"

export type ToolKitSpec = {
    name : string
    tools: object[]
    description?: string
}

function validateToolKit(raw : unknown) : raw is ToolKitSpec {
    if (raw === null) throw Error(Messages.kit.baseNull())
    if (typeof raw !== "object" )
        throw Error(Messages.kit.baseNeedsNameTools(raw))
    if (!("name" in raw && typeof raw.name === "string"))
        throw Error(Messages.kit.nameMissing())

    const name = raw.name
    if (!("tools" in raw)) throw Error(Messages.kit.toolsMissing(name))
    if (!(Array.isArray(raw.tools)))
        throw Error(Messages.kit.toolsType(name))
    if (!(raw.tools.every((t : unknown) => typeof t === "object")))
        throw Error(Messages.kit.toolsItems(name))

    if ("description" in raw && typeof raw.description !== "string") {
        throw Error(Messages.kit.descriptionType())
    }

    return true
}

type DialecticHeaderSpec = {
    interlocutor : Interlocutor
    interlocutors? : [ ...Interlocutor[] ]
    macros?: MacroSpec[]
    hooks?: HookSpec[]
    kits? : ToolKitSpec[]
    sandbox? : string
}

type ManylecticHeaderSpec = {
    interlocutors : [ Interlocutor, ...Interlocutor[] ]
    macros?: MacroSpec[]
    hooks?: HookSpec[]
    kits? : ToolKitSpec[]
    sandbox? : string
}

export type LecticHeaderSpec = DialecticHeaderSpec | ManylecticHeaderSpec

export class LecticHeader {
    interlocutor : Interlocutor
    interlocutors : Interlocutor[]
    macros: Macro[]
    hooks: Hook[]
    kits: ToolKitSpec[]
    spec: LecticHeaderSpec
    sandbox? : string
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
        this.spec = spec
        this.sandbox = spec.sandbox
        this.macros = (spec.macros ?? []).map(spec => new Macro(spec))
        this.hooks = (spec.hooks ?? []).map(spec => new Hook(spec))
        this.kits = spec.kits ?? []
    }

    // Apply post-merge normalization shared by all merge pipelines.
    // If both 'interlocutor' and an entry in 'interlocutors' share
    // the same name, merge them so the single interlocutor includes
    // the properties from its list counterpart.
    static normalizeMergedSpec(raw: unknown): unknown {
        if (!isObjectRecord(raw)) return raw
        const curInterlocutor = raw['interlocutor']
        const interlocutors = raw['interlocutors']
        if (!isObjectRecord(curInterlocutor) || !Array.isArray(interlocutors)) return raw
        const nameVal = curInterlocutor['name']
        if (!(typeof nameVal === 'string')) return raw
        const otherInterlocutor = interlocutors.find((inter: unknown) => {
            return isObjectRecord(inter) && inter['name'] === nameVal
        })
        if (otherInterlocutor) {
            raw['interlocutor'] = mergeValues(otherInterlocutor, curInterlocutor)
        }
        return raw
    }

    static mergeInterlocutorSpecs(yamls : (string | null)[]) {

        const raw = yamls.filter(x => x !== null)
            .map(h => YAML.parse(h))
            .reduce(mergeValues)
        return LecticHeader.normalizeMergedSpec(raw)
    }

    setSpeaker(name : string) {
        const newSpeaker = this.interlocutors.find(inter => inter.name === name)
        if (newSpeaker) {
            this.interlocutor = newSpeaker
        } else {
            throw Error(`There's not an interlocutor named ${name}`)
        }
    }

    private expandTools(tools: object[]): object[] {
        const out: object[] = []
        const idx = new Map<string, ToolKitSpec>()
        for (const b of this.kits) idx.set(b.name, b)
        const seen = new Set<string>()
        const expandOne = (spec: object) => {
            if (spec && "kit" in spec && typeof spec.kit === 'string') {
                const name = spec.kit
                if (seen.has(name)) throw Error(Messages.kit.cycle(name))
                const kit = idx.get(name)
                if (!kit) throw Error(Messages.kit.unknownReference(name))
                seen.add(name)
                for (const inner of kit.tools) expandOne(inner)
                seen.delete(name)
            } else {
                out.push(spec)
            }
        }
        for (const s of tools) expandOne(s)
        return out
    }

    async initialize() {

        if (this.interlocutor.registry) return

        this.interlocutor.prompt = await loadFrom(this.interlocutor.prompt)

        this.interlocutor.registry = {}
        this.interlocutor.active_hooks = (this.interlocutor.hooks ?? []).map(h => new Hook(h))

        const toolSpecs = Array.isArray(this.interlocutor.tools)
          ? this.expandTools(this.interlocutor.tools)
          : []

        for (const spec of toolSpecs) {
            // TODO it'd be nice to just have the tools save their
            // registration boilerplate on to Tool as each class is defined
            const register = (tool : Tool) => {
                if (this.interlocutor.registry === undefined) return
                if (tool.name in this.interlocutor.registry) {
                    throw Error(`the name ${tool.name} is being used twice. Each tool needs a unique name`)
                } else {
                    this.interlocutor.registry[tool.name] = tool 
                }
            }
            if (isExecToolSpec(spec)) {
                // don't mutate spec, it's confusing elsewhere if the
                // tool spec starts to not match the YAML, for example
                // if the YAML uses &* references
                const loadedSpec: ExecToolSpec = { ...spec }
                loadedSpec.usage = await loadFrom(spec.usage)
                loadedSpec.sandbox =
                    loadedSpec.sandbox ?? this.interlocutor.sandbox ?? this.sandbox

                register(new ExecTool(loadedSpec, this.interlocutor.name))
            } else if (isSQLiteToolSpec(spec)) {
                const loadedSpec: SQLiteToolSpec = { ...spec }
                loadedSpec.details = await loadFrom(spec.details)
                register(new SQLiteTool(loadedSpec))
            } else if (isThinkToolSpec(spec)) {
                register(new ThinkTool(spec))
            } else if (isServeToolSpec(spec)) {
                register(new ServeTool(spec))
            } else if (isAgentToolSpec(spec)) {
                const loadedSpec: AgentToolSpec = { ...spec }
                loadedSpec.usage = await loadFrom(spec.usage)
                register(new AgentTool(loadedSpec, this.interlocutors))
            } else if (isMCPSpec(spec)) {
                const loadedSpec = { ...spec }
                if ("mcp_command" in loadedSpec) {
                     loadedSpec.sandbox =
                        loadedSpec.sandbox ?? this.interlocutor.sandbox ?? this.sandbox
                }
                (await MCPTool.fromSpec(loadedSpec)).map(register)
            } else if (isNativeTool(spec)) {
               // do nothing 
            } else {
                throw Error(`The tool provided by ${JSON.stringify(spec)} wasn't recognized. ` +
                            `Check the tool section of your YAML header.`)
            }
        }

    }
}

// This is similar to isLecticHeaderSpec, but throws on failed validation
export function validateLecticHeaderSpec(raw : unknown) : raw is LecticHeaderSpec {
    if (raw === null) throw Error(Messages.header.baseNull())
    if (!isObjectRecord(raw)) throw Error(Messages.header.baseType())

    const hasInterlocutor = 'interlocutor' in raw
    const hasInterlocutors = 'interlocutors' in raw

    if (!hasInterlocutor && !hasInterlocutors) {
        throw Error(Messages.header.missingInterlocutor())
    }

    if (hasInterlocutor) {
        validateInterlocutor(raw['interlocutor'])
    }

    if (hasInterlocutors) {
        if (!Array.isArray(raw['interlocutors'])) {
            throw Error(Messages.header.interlocutorsType())
        }
        raw['interlocutors'].every(validateInterlocutor)

        if (!hasInterlocutor && raw['interlocutors'].length === 0) {
            throw Error(Messages.header.interlocutorsEmpty())
        }
    }

    if ('macros' in raw) {
        if (!Array.isArray(raw['macros'])) { throw Error(Messages.header.macrosType()) }
        raw['macros'].every(validateMacroSpec)
    }

    if ('sandbox' in raw && !(typeof raw['sandbox'] === "string")) {
        throw Error(Messages.header.sandboxType())
    }

    if ('hooks' in raw) {
        if (!Array.isArray(raw['hooks'])) { throw Error(Messages.header.hooksType()) }
        raw['hooks'].every(validateHookSpec)
    }

    if ('kits' in raw) {
        if (!Array.isArray(raw['kits'])) { throw Error(Messages.header.kitsType()) }
        raw['kits'].every(validateToolKit)
    }

    return true
}

export function isLecticHeaderSpec(raw : unknown) : raw is LecticHeaderSpec {
    try {
        return validateLecticHeaderSpec(raw)
    } catch {
        return false
    }
}

export class LecticBody {
    messages : Message[]
    raw: string

    constructor({ messages, raw } : { messages: Message[], raw: string }) {
        this.messages = messages
        this.raw = raw
    }


    snapshot(opt: { closeBlock?: boolean } = {}): string {
        if (opt.closeBlock) {
             return `${this.raw}\n\n:::`
        }
        return this.raw
    }
}

export function isLecticBody(raw: unknown): raw is LecticBody {
    return raw !== null &&
        typeof raw === 'object' &&
        'messages' in raw &&
        Array.isArray(raw.messages) &&
        raw.messages.every(isMessage) &&
        'raw' in raw &&
        typeof raw.raw === 'string' &&
        'snapshot' in raw
}

export type HasModel = { header : { interlocutor : { model : string } } }

export class Lectic {
    header : LecticHeader
    body : LecticBody
    constructor({ header, body } : {header : LecticHeader, body : LecticBody }) {
        this.header = header
        this.body = body
    }

    applyYaml(yaml : string) {
        const merged = mergeValues(this.header.spec, YAML.parse(yaml))
        const newSpec = LecticHeader.normalizeMergedSpec(merged)
        try { 
            if (validateLecticHeaderSpec(newSpec)) {
                this.header = new LecticHeader(newSpec)
            }
        }
        catch (e) {
            if (e instanceof Error) {
                throw new Error(`merge_yaml produced a malformed header: ${e.message}`)
            } else {
                throw new Error(`merge_yaml produced a malformed header: ${e}`)
            }
        }
    }

    async processMessages() {
        const last = this.body.messages.length - 1
        let messages = this.body.messages
        for (let idx = 0; idx < this.body.messages.length; idx++) {
            const message = this.body.messages[idx]
            if (message instanceof UserMessage) {
                await message.expandMacros(this.header.macros, { 
                    MESSAGE_INDEX : idx + 1,
                    MESSAGES_LENGTH : this.body.messages.length
                })
                for (const directive of message.containedDirectives()) {
                    switch (directive.name) {
                        case "ask": {
                            this.header.setSpeaker(directive.text)
                            break
                        }
                        case "aside": {
                            if (idx === last) this.header.setSpeaker(directive.text)
                            break
                        }
                        case "reset" : {
                            if (idx < last) messages = this.body.messages.slice(idx + 1)
                            break
                        }
                        case "merge_yaml" : {
                            this.applyYaml(directive.text)
                            break
                        }
                        case "temp_merge_yaml" : {
                            if (idx === last) this.applyYaml(directive.text)
                            break
                        }
                    }
                }
            }
        }
        this.body.messages = messages
    }
}

export function isLectic(raw: unknown): raw is Lectic {
    return raw !== null &&
        typeof raw === 'object' &&
        'header' in raw &&
        'body' in raw &&
        (raw.header instanceof LecticHeader) &&
        isLecticBody(raw.body)
}
