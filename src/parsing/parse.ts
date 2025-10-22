import { LecticHeader, validateLecticHeaderSpec } from "../types/lectic"
import type { Message } from "../types/message"
import { UserMessage, AssistantMessage } from "../types/message"
import { Lectic } from "../types/lectic"
import { remark } from "remark"
import { nodeRaw, nodeContentRaw } from "./markdown"
import remarkDirective from "remark-directive"
import { lecticConfigDir } from "../utils/xdg"
import { readWorkspaceConfig } from "../utils/workspace"
import { join } from "path"

export function getYaml(raw:string) : string | null {
    let expr = /^---\n([\s\S]*?)\n(?:---|\.\.\.)/
    let match = expr.exec(raw)
    return match?.[1] ?? null
}

export function getBody(raw:string) : string {
    let expr = /^---[\s\S]*?(?:---|\.\.\.)([\s\S]*)$/
    let match = expr.exec(raw)
    return match?.[1] ?? raw
}

export function bodyToMessages(raw : string, header : LecticHeader) : Message[] {

    const ast = remark()
        .use(remarkDirective)
        .parse(raw)

    const messages : Message[] = []

    let cur = ""

    for (const node of ast.children) {
        if (node.type == "containerDirective") {
            messages.push(new UserMessage({ content: cur }))
            const interlocutor = header.interlocutors.find(i => i.name == node.name)
            if (interlocutor === undefined) throw Error(`interlocutor ${node.name} can't be found!`)
            cur = ""
            messages.push(new AssistantMessage({ content: nodeContentRaw(node, raw), interlocutor }))
        } else {
            cur += `\n\n${nodeRaw(node, raw)}`
        }
    }

    if (cur.length > 0) {
        messages.push(new UserMessage({ content: cur }))
    }

    return messages
}

export async function parseLecticHeaderSpec(
    raw: string,
    includes: (string | null)[]
): Promise<unknown> {
    const rawYaml = getYaml(raw) ?? ""
    try {
        return LecticHeader.mergeInterlocutorSpecs([...includes, rawYaml])
    } catch {
        return {}
    }
}

export async function mergedHeaderSpecForDoc(
    docText: string,
    docPath: string | undefined
): Promise<unknown> {
    const systemConfig = join(lecticConfigDir(), "lectic.yaml")
    const systemYaml = await Bun.file(systemConfig).text().catch(_ => null)
    if (docPath !== undefined) {
        const workspaceYaml = await readWorkspaceConfig(docPath)
        return parseLecticHeaderSpec(docText, [systemYaml, workspaceYaml])
    }
    return parseLecticHeaderSpec(docText, [systemYaml])
}

export async function parseLectic(raw: string, include : (string | null)[]) : Promise<Lectic> {

    const rawYaml = getYaml(raw)
    const rawBody = getBody(raw)
    let headerSpec: unknown

    try {
        headerSpec = LecticHeader.mergeInterlocutorSpecs([...include, rawYaml])
    } catch {
        throw new Error('could not parse YAML header, no include header provided')
    }


    if (!validateLecticHeaderSpec(headerSpec)) throw Error(
         "YAML Header is missing something. " +
         "One or more interlocutors need to be specified. " +
         "(Use either `interlocutor:` for a single interlocutor, " + 
         "or `interlocutors:` for a list, " + 
         "and include at least a name and prompt for each interlocutor)."
    )

    const header = new LecticHeader(headerSpec)

    const messages = bodyToMessages(rawBody, header)

    return new Lectic({ header, body : { messages }})
}
