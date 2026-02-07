import { LecticHeader, validateLecticHeaderSpec, LecticBody } from "../types/lectic"
import type { Message } from "../types/message"
import { UserMessage, AssistantMessage } from "../types/message"
import { Lectic } from "../types/lectic"
import { remark } from "remark"
import { nodeRaw, nodeContentRaw } from "./markdown"
import remarkDirective from "remark-directive"
import {
  type ConfigResolutionIssue,
  resolveConfigChain,
} from "../utils/configDiscovery"
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
        if (node.type === "containerDirective") {
            messages.push(new UserMessage({ content: cur }))
            const interlocutor = header.interlocutors.find(i => i.name === node.name)
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

export type MergeIssue = ConfigResolutionIssue

export type HeaderMergeResult = {
    spec: unknown
    errors: MergeIssue[]
}

export async function mergedHeaderSpecForDocDetailed(
    docText: string,
    docPath: string | undefined
): Promise<HeaderMergeResult> {
    const headerYaml = getYaml(docText)

    const { sources, issues } = await resolveConfigChain({
      includeSystem: true,
      workspaceStartDir: docPath,
      document: { yaml: headerYaml, dir: docPath },
    })

    let merged: unknown = {}
    for (const source of sources) {
      if (source.parsed === null || source.parsed === undefined) continue
      merged = mergeValues(merged, source.parsed)
    }

    const spec = LecticHeader.normalizeMergedSpec(merged)

    return { spec, errors: issues }
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

    return new Lectic({ header, body : new LecticBody({ messages, raw })})
}
