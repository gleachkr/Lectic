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
import * as YAML from "yaml"
import { mergeValues } from "../utils/merge"

export function getYaml(raw:string) : string | null {
    const expr = /^---\n([\s\S]*?)\n(?:---|\.\.\.)/
    const match = expr.exec(raw)
    return match?.[1] ?? null
}

export function getBody(raw:string) : string {
    const expr = /^---[\s\S]*?(?:---|\.\.\.)([\s\S]*)$/
    const match = expr.exec(raw)
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

export type MergeIssue = {
    source: 'system' | 'workspace' | 'document'
    phase: 'parse' | 'merge'
    message: string
}

export type HeaderMergeResult = {
    spec: unknown
    errors: MergeIssue[]
}

export async function mergedHeaderSpecForDocDetailed(
    docText: string,
    docPath: string | undefined
): Promise<HeaderMergeResult> {
    const systemConfig = join(lecticConfigDir(), "lectic.yaml")
    const systemYaml = await Bun.file(systemConfig).text().catch(_e => null)
    const headerYaml = getYaml(docText) ?? ""
    const workspaceYaml = docPath !== undefined
        ? await readWorkspaceConfig(docPath)
        : null

    type Src = { key: 'system'|'workspace'|'document', text: string | null }
    const sources: Src[] = [
        { key: 'system', text: systemYaml },
        { key: 'workspace', text: workspaceYaml },
        { key: 'document', text: headerYaml }
    ]

    const parsed: { key: Src['key'], obj: unknown }[] = []
    const errors: MergeIssue[] = []

    for (const s of sources) {
        if (s.text == null) continue
        try {
            const obj = YAML.parse(s.text)
            parsed.push({ key: s.key, obj })
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e)
            errors.push({ source: s.key, phase: 'parse', message: msg })
        }
    }

    let merged: unknown = {}
    for (const p of parsed) {
        merged = mergeValues(merged, p.obj)
    }

    // Apply shared normalization from LecticHeader
    const spec = LecticHeader.normalizeMergedSpec(merged)

    return { spec, errors }
}

export async function parseLectic(raw: string, include : (string | null)[]) : Promise<Lectic> {

    const rawYaml = getYaml(raw)
    const rawBody = getBody(raw)
    let headerSpec: unknown

    try {
        headerSpec = LecticHeader.mergeInterlocutorSpecs([...include, rawYaml])
    } catch (e) {
        if (e instanceof Error) {
            throw new Error(`could not parse YAML header: ${e.message}.`)
        } else {
            throw new Error(`could not parse YAML header.`)
        }
    }

    if (!validateLecticHeaderSpec(headerSpec)) throw Error(
         "Something's wrong with the YAML Header."
    )

    const header = new LecticHeader(headerSpec)

    const messages = bodyToMessages(rawBody, header)

    return new Lectic({ header, body : { messages, raw }})
}
