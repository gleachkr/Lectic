import { isLecticHeader } from "../types/lectic"
import { Message } from "../types/message"
import type { Lectic } from "../types/lectic"
import * as YAML from "yaml"
import { isExecToolSpec } from "../tools/exec"
import { remark } from "remark"
import { nodeRaw, nodeContentRaw } from "./markdown"
import remarkDirective from "remark-directive"

export function getYaml(raw:string) : string | null {
    let expr = /^---\n([\s\S]*?)\n(?:---|\.\.\.)/m
    let match = expr.exec(raw)
    if (match?.[1]) {
        return match[1]
    } else {
        return null
    }
}

export function getBody(raw:string) : string | null {
    let expr = /^---[\s\S]*?(?:---|\.\.\.)([\s\S]*)$/m
    let match = expr.exec(raw)
    if (match?.[1]) {
        return match[1]
    } else {
        return null
    }
}


export function bodyToMessages(raw : string) : Message[] {

    const ast = remark()
        .use(remarkDirective)
        .parse(raw)

    const messages : Message[] = []

    let cur = ""

    for (const node of ast.children) {
        if (node.type == "containerDirective") {
            messages.push(new Message({
                role: "user",
                content: cur
            }))
            cur = ""
            messages.push(new Message({
                role: "assistant",
                content: nodeContentRaw(node, raw)
            }))
        } else {
            cur += `\n\n${nodeRaw(node, raw)}`
        }
    }

    if (cur.length > 0) {
        messages.push(new Message({
            role: "user",
            content: cur
        }))
    }

    return messages
}

export async function parseLectic(raw: string) : Promise<Lectic> {
    const rawYaml = getYaml(raw)
    const rawBody = getBody(raw)

    if (!rawYaml) throw new Error('could not parse YAML header')
    if (!rawBody) throw new Error('could not parse Lectic Body')

    const header: unknown = YAML.parse(rawYaml)

    if (!isLecticHeader(header)) throw Error("YAML Header contains either unrecognized fields or is missing a field")

    // TODO DRY the "load from file" pattern

    // load prompt from file if available
    if (await Bun.file(header.interlocutor.prompt.trim()).exists()) {
        header.interlocutor.prompt = await Bun.file(header.interlocutor.prompt.trim()).text()
    }

    // load memories from file if available
    if (header.interlocutor.memories && 
        await Bun.file(header.interlocutor.memories.trim()).exists()) {
        header.interlocutor.prompt = await Bun.file(header.interlocutor.memories.trim()).text()
    }

    // load usage from file if available
    if (header.interlocutor.tools) {
        for (const tool of header.interlocutor.tools) {
            if (isExecToolSpec(tool) && tool.usage &&
                await Bun.file(tool.usage.trim()).exists()) {
                tool.usage = await Bun.file(tool.usage.trim()).text()
            }
        }
    }

    const messages = bodyToMessages(rawBody)

    return { header, body : { messages }}
}
