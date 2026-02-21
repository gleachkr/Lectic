import { unwrap, extractElements, escapeTags, unescapeTags } from "../parsing/xml.ts"
import { serialize, deserialize, validateAgainstSchema } from "./schema.ts"
import type { JSONSchema } from "./schema.ts"
import { Hook, type HookSpec } from "./hook"

export class ToolCallResult {
    mimetype: string
    content: string
    constructor(content: string, mimetype?: string ) {
        this.mimetype = mimetype ?? "text/plain"
        this.content = content
    }

    get type(): "text" { return "text" }
    get text(): string { return this.content }

    // Serialize this result to a <result> XML element
    // For non-text/application types, we serialize the content as a
    // literal URI string. Retrieval is handled later by providers.
    toXml(): string {
        return `<result type="${this.mimetype}">${escapeTags(this.content)}</result>`
    }

    toBlock(): { type: "text", text: string, toString: () => string } { 
        const text = this.content
        return { type: "text" as const, text, toString: () => text }
    }

    // Build a result from a <result> XML element
    static fromXml(xml: string): ToolCallResult {
        const match = resultRegex.exec(xml.trim())
        if (!match) throw Error(`Couldn't deserialize ${xml} as tool call result`)
        const [, mimetype, content] = match
        return new ToolCallResult(unescapeTags(content), mimetype)
    }

    // Convenience: build one or many results from string(s)
    static fromStrings(s: string | string[], mimetype?: string): ToolCallResult[] {
        mimetype = mimetype ?? "text/plain"
        const mk = (content: string) => new ToolCallResult(content, mimetype)
        return typeof s === "string" ? [mk(s)] : s.map(mk)
    }
}

export abstract class Tool {
    abstract name: string
    abstract description: string
    abstract parameters: { [_ : string] : JSONSchema }
    abstract required : string[]
    abstract kind: string
    icon?: string = ""
    hooks: Hook[]

    constructor(hooks?: HookSpec[]) {
        this.hooks = (hooks ?? []).map(h => new Hook(h))
    }

    abstract call (arg : unknown) : Promise<ToolCallResult[]>

    validateArguments(args: Record<string, unknown>) {
        for (const key of this.required) {
            if (!(key in args)) {
                throw new Error(`Missing required argument: ${key}`);
            }
        }

        for (const key of Object.keys(args)) {
            if (!(key in this.parameters)) {
                throw new Error(`Unknown argument: ${key}`);
            }
            validateAgainstSchema(args[key], this.parameters[key]);
        }
    }
}

export type ToolCall = { 
    name: string, 
    args : Record<string, unknown>, 
    results : ToolCallResult[]
    id? : string
    isError? : boolean
}

// Backwards-compatible helper; prefer ToolCallResult.fromStrings
export function ToolCallResults(s : string | string[], mimetype? : string) : ToolCallResult[] {
    return ToolCallResult.fromStrings(s, mimetype)
}

const resultRegex = /<result\s+type="(.*?)"\s*>([\s\S]*)<\/result>/

function escapeXmlAttribute(value: string): string {
    return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;")
}

function unescapeXmlAttribute(value: string): string {
    return value.replace(/&quot;/g, '"').replace(/&amp;/g, "&")
}

export function serializeCall(tool: Tool | null, {name, args, results, id, isError} : ToolCall) : string {
    const values = [] 
    if (tool) {
        for (const key in tool.parameters) {
            if (key in args) {
                const s = tool.parameters[key]
                const attr = 'type' in s && s.type === "string" && s.contentMediaType
                    ? ` contentMediaType="${s.contentMediaType}` + `"`
                    : ""
                values.push(`<${key}${attr}>${serialize(args[key], tool.parameters[key])}</${key}>`)
            }
            // missing required parameters are caught by schema validation and the error is passed to the LLM.
            // so we still serialize in that case, to let processing continue
        }
    }

    const idstring = id ? ` id="${id}"` : ""
    const errorstring = isError !== undefined ? ` is-error="${isError}"` : ""
    const kindstring = tool ? ` kind="${tool.kind}"` : ""
    const iconstring = tool?.icon
        ? ` icon="${escapeXmlAttribute(tool.icon)}"`
        : ""

    return `<tool-call with="${name}"${idstring}${errorstring}${kindstring}${iconstring}>\n` +
        `<arguments>${values.join("\n")}</arguments>\n` +
        `<results>${results.map(r => r.toXml()).join("\n")}</results>\n` +
    `</tool-call>`
}

const toolCallRegex = /^<tool-call\b([^>]*)>([\s\S]*)<\/tool-call>$/

export function deserializeCall(tool: Tool | null, serialized : string) 
    : ToolCall | null {

    const match = toolCallRegex.exec(serialized.trim())
    if (!match) return null

    const attrsStr = match[1]
    const inner = match[2]

    const attributes: Record<string, string> = {}
    const re = /([a-zA-Z0-9_:-]+)="([^"]*)"/g
    let m
    while ((m = re.exec(attrsStr)) !== null) {
        attributes[m[1]] = unescapeXmlAttribute(m[2])
    }

    const name = attributes["with"]
    const id = attributes["id"]
    const isErrorStr = attributes["is-error"]

    if (!name) return null

    const [argstring, results] = extractElements(inner)

    let args: Record<string, unknown> = {}

    if (tool) {
        const parsed = deserialize(`<object>${unwrap(argstring, "arguments")}</object>`, {
            type: "object" as const,
            description: "tool call parameters",
            properties: tool.parameters
        }) as Record<string, unknown>
        args = parsed
        if (name !== tool.name) throw new Error(`Unexpected tool-call name, expected "${tool.name}", got "${name}"`)
    }

    const resultsArray = extractElements(unwrap(results, "results"))

    const isError = isErrorStr === "true" ? true : isErrorStr === "false" ? false : undefined
    return { name, args, results : resultsArray.map(ToolCallResult.fromXml), id, isError }
}

export function getSerializedCallName(call : string) : string | null {
    const match = toolCallRegex.exec(call.trim())
    if (!match) return null
    const nameMatch = /with="([^"]*)"/.exec(match[1])
    return nameMatch ? nameMatch[1] : null
}

export function isSerializedCall(call : string) : boolean {
    return toolCallRegex.test(call.trim())
}
