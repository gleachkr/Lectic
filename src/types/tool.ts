import {unwrap, extractElements } from "../parsing/xml.ts"
import { serialize, deserialize } from "./schema.ts"
import type { JSONSchema } from "./schema.ts"

export abstract class Tool {
    abstract name: string
    abstract description: string
    abstract parameters: { [_ : string] : JSONSchema }
    abstract required? : string[] //TODO: this should not be optional
    abstract call (arg : any) : Promise<string>

    register() {
        if (this.name in Tool.registry) {
            throw new Error("Two tools were given the same name. Check the tool section of your YAML header.") 
        } else {
            Tool.registry[this.name] = this
        }
    }

    static registry : { [key: string] : Tool } = {}
}

export type ToolCall = { 
    name: string, 
    args : { [key : string] : any }, 
    result : string 
    id? : string
    isError? : boolean
}

export function serializeCall(tool: Tool, {args, result, id, isError} : ToolCall) : string {
    let values = [] 
    for (const key in tool.parameters) {
        if (key in args) {
            values.push(`<${key}>${serialize(args[key], tool.parameters[key])}</${key}>`)
        } else if (tool.required && key in tool.required) {
            throw new Error(`missing required parameter: ${key}`)
        }
    }

    const idstring = id ? ` id="${id}"` : ""
    const errorstring = isError !== undefined ? ` is-error="${isError}"` : ""

    return `<tool-call with="${tool.name}"${idstring}${errorstring}>\n` +
        `<arguments>${values.join("\n")}</arguments>\n` +
        `<result>${result}</result>\n` +
    `</tool-call>`
}

const toolCallRegex = /^<tool-call\s+with="(.*?)"(\s+id="(.*?)")?(\s+is-error="(.*?)")?\s*>([\s\S]*)<\/tool-call>$/

export function deserializeCall(tool: Tool, serialized : string) 
    : ToolCall | null {
    const match = toolCallRegex.exec(serialized.trim())
    if (!match) return null
    const [,name,, id,, isErrorStr, inner] = match
    let [argstring, result] = extractElements(inner)
    argstring = `<object>${unwrap(argstring, "arguments")}</object>`
    result = unwrap(result, "result")

    if (name !== tool.name) throw new Error(`Unexpected tool-call name, expected "${tool.name}", got "${name}"`)

    const isError = isErrorStr === "true" ? true : isErrorStr === "false" ? false : undefined
    const argschema = {
        type: "object" as const,
        description: "tool call parameters",
        properties: tool.parameters
    }
    const args = deserialize(argstring, argschema)
    return { name: tool.name, args, result, id, isError }
}

export function getSerializedCallName(call : string) : string | null {
    const result = toolCallRegex.exec(call.trim())
    return result && result[1]
}

export function isSerializedCall(call : string) : boolean {
    const result = toolCallRegex.test(call.trim())
    return result
}

