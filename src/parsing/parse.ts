import { LecticHeader, validateLecticHeaderSpec } from "../types/lectic"
import type { Message } from "../types/message"
import { UserMessage, AssistantMessage } from "../types/message"
import type { Lectic } from "../types/lectic"
import * as YAML from "yaml"
import { remark } from "remark"
import { nodeRaw, nodeContentRaw } from "./markdown"
import remarkDirective from "remark-directive"

export function getYaml(raw:string) : string | null {
    let expr = /^---\n([\s\S]*?)\n(?:---|\.\.\.)/m
    let match = expr.exec(raw)
    return match?.[1] ?? null
}

export function getBody(raw:string) : string | null {
    let expr = /^---[\s\S]*?(?:---|\.\.\.)([\s\S]*)$/m
    let match = expr.exec(raw)
    return match?.[1] ?? null
}

export function bodyToMessages(raw : string) : Message[] {

    const ast = remark()
        .use(remarkDirective)
        .parse(raw)

    const messages : Message[] = []

    let cur = ""

    for (const node of ast.children) {
        if (node.type == "containerDirective") {
            messages.push(new UserMessage({ content: cur }))
            cur = ""
            messages.push(new AssistantMessage({ 
                content: nodeContentRaw(node, raw),
                name: node.name
            }))
        } else {
            cur += `\n\n${nodeRaw(node, raw)}`
        }
    }

    if (cur.length > 0) {
        messages.push(new UserMessage({ content: cur }))
    }

    return messages
}


export async function parseLectic(raw: string) : Promise<Lectic> {
    const rawYaml = getYaml(raw)
    const rawBody = getBody(raw)

    if (rawYaml === null) throw new Error('could not parse YAML header')
    if (rawBody === null) throw new Error('could not parse Lectic Body')

    const headerSpec: unknown = YAML.parse(rawYaml)

    if (!validateLecticHeaderSpec(headerSpec)) throw Error(
         "YAML Header is missing something. " +
         "One or more interlocutors need to be specified. " +
         "(Use either `interlocutor:` or `interlocutors:`, and include at least a name and prompt).")

    const header = new LecticHeader(headerSpec)

    const messages = bodyToMessages(rawBody)

    return { header, body : { messages }}
}
