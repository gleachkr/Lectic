import { unwrap, extractElements, escapeTags, unescapeTags } from "../parsing/xml.ts"
import { serialize, deserialize, validateAgainstSchema } from "./schema.ts"
import type { JSONSchema } from "./schema.ts"

export type ToolCallResult = ToolCallResultText

export type ToolCallResultText = {
    type : "text",
    text : string
}

export abstract class Tool {
    abstract name: string
    abstract description: string
    abstract parameters: { [_ : string] : JSONSchema }
    abstract required? : string[] //TODO: this should not be optional
    abstract call (arg : any) : Promise<ToolCallResult[]>

    validateArguments(args: {[key : string] : unknown}) {
        if (this.required) {
            for (const key of this.required) {
                if (!(key in args)) {
                    throw new Error(`Missing required argument: ${key}`);
                }
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
    args : { [key : string] : any }, 
    results : ToolCallResult[]
    id? : string
    isError? : boolean
}

export function ToolCallResults(s : string | string[]) : ToolCallResult[] {
    if (typeof s === "string") {
        return [{ type: "text", text: s}]
    } else {
        return s.map(text => ({ type: "text", text}))
    }
}

const resultRegex = /<result\s+type="(.*?)"\s*>([\s\S]*)<\/result>/

function serializeResult(result : ToolCallResult) : string {
    if (result.type === "text") {
        return `<result type="text">${escapeTags(result.text)}</result>`
    } else {
        throw Error(`Unreachable code: unrecognized result type: ${result.type}`)
    }
}

function deserializeResult(xml : string) : ToolCallResult  {
    const match = resultRegex.exec(xml.trim())
    if (!match) throw Error(`Couldn't deserialize ${xml} as tool call result`)
    const [,type,content] = match
    if (type === "text") {
        return { type, text: unescapeTags(content) } 
    }
    throw Error(`Unrecognized type in tool call result deserialization`)
}

export function serializeCall(tool: Tool | null, {name, args, results, id, isError} : ToolCall) : string {
    let values = [] 
    if (tool) {
        for (const key in tool.parameters) {
            if (key in args) {
                values.push(`<${key}>${serialize(args[key], tool.parameters[key])}</${key}>`)
            } else if (tool.required && key in tool.required) {
                throw new Error(`missing required parameter: ${key}`)
            }
        }
    }

    const idstring = id ? ` id="${id}"` : ""
    const errorstring = isError !== undefined ? ` is-error="${isError}"` : ""

    return `<tool-call with="${name}"${idstring}${errorstring}>\n` +
        `<arguments>${values.join("\n")}</arguments>\n` +
        `<results>${results.map(serializeResult).join("\n")}</results>\n` +
    `</tool-call>`
}

const toolCallRegex = /^<tool-call\s+with="(.*?)"(\s+id="(.*?)")?(\s+is-error="(.*?)")?\s*>([\s\S]*)<\/tool-call>$/

export function deserializeCall(tool: Tool | null, serialized : string) 
    : ToolCall | null {

    const match = toolCallRegex.exec(serialized.trim())
    if (!match) return null

    const [,name,, id,, isErrorStr, inner] = match
    let [argstring, results] = extractElements(inner)

    let args = []

    if (tool) {
        args = deserialize(`<object>${unwrap(argstring, "arguments")}</object>`, {
            type: "object" as const,
            description: "tool call parameters",
            properties: tool.parameters
        })
        if (name !== tool.name) throw new Error(`Unexpected tool-call name, expected "${tool.name}", got "${name}"`)
    }

    const resultsArray = extractElements(unwrap(results, "results"))

    const isError = isErrorStr === "true" ? true : isErrorStr === "false" ? false : undefined
    return { name, args, results : resultsArray.map(deserializeResult), id, isError }
}

export function getSerializedCallName(call : string) : string | null {
    const result = toolCallRegex.exec(call.trim())
    return result && result[1]
}

export function isSerializedCall(call : string) : boolean {
    const result = toolCallRegex.test(call.trim())
    return result
}

