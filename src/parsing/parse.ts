import { isLecticHeaderSpec, LecticHeader } from "../types/lectic"
import type { Message } from "../types/message"
import { UserMessage, AssistantMessage } from "../types/message"
import type { Lectic } from "../types/lectic"
import * as YAML from "yaml"
import { remark } from "remark"
import { nodeRaw, nodeContentRaw } from "./markdown"
import remarkDirective from "remark-directive"
import { isExecToolSpec, ExecTool } from "../tools/exec"
import { isSQLiteToolSpec, SQLiteTool } from "../tools/sqlite"
import { isThinkToolSpec, ThinkTool } from "../tools/think"
import { isMCPSpec, MCPTool } from "../tools/mcp"

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

    if (!rawYaml) throw new Error('could not parse YAML header')
    if (!rawBody) throw new Error('could not parse Lectic Body')

    const headerSpec: unknown = YAML.parse(rawYaml)

    if (!isLecticHeaderSpec(headerSpec)) throw Error(
         "YAML Header is missing something. " +
         "One or more interlocutors need to be specified. " +
         "(Use either `interlocutor:` or `interlocutors:`, and include at least a name and prompt).")

    const header = new LecticHeader(headerSpec)

    // TODO DRY the "load from file" pattern

    // load prompt from file if available
    if (await Bun.file(header.interlocutor.prompt.trim()).exists()) {
        header.interlocutor.prompt = await Bun.file(header.interlocutor.prompt.trim()).text()
    }

    // load memories from file if available
    if (header.interlocutor.memories &&
        typeof header.interlocutor.memories == "string" &&
        await Bun.file(header.interlocutor.memories.trim()).exists()) {
        header.interlocutor.prompt = await Bun.file(header.interlocutor.memories.trim()).text()
    }

    if (header.interlocutor.tools) {
        for (const spec of header.interlocutor.tools) {
            // load usage from file if available
            if (isExecToolSpec(spec)) {
                if (spec.usage && await Bun.file(spec.usage.trim()).exists()) {
                    spec.usage = await Bun.file(spec.usage.trim()).text()
                }
                new ExecTool(spec)
            } else if (isSQLiteToolSpec(spec)) {
                new SQLiteTool(spec)
            } else if (isThinkToolSpec(spec)) {
                new ThinkTool(spec)
            } else if (isMCPSpec(spec)) {
                await MCPTool.fromSpec(spec)
            } else {
                throw Error("One or more tools provided were not recognized. Check the tool section of your YAML header.")
            }
        }
    }

    const messages = bodyToMessages(rawBody)

    return { header, body : { messages }}
}
