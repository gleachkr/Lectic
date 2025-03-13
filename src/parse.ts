import { isLecticHeader } from "./types/lectic"
import { Message } from "./types/message"
import type { Lectic } from "./types/lectic"
import * as YAML from "yaml"
import { isExecToolSpec } from "./tools/exec"

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

export function splitBodyChunks(input: string): string[] {
    const lines = input.split('\n')
    let matches : string[] = []
    let match : string[] = []
    let user = true
    for (const line of lines) {
        if (/^:::/.exec(line)) {
            if (user) {
                user = false
                matches.push(match.join('\n'))
                match = [line]
            } else {
                user = true
                match.push(line)
                matches.push(match.join('\n'))
                match = []
            }
        } else {
            match.push(line)
        }
    }
    matches.push(match.join('\n'))

    matches = matches
        .map(m => m.trim())
        .filter(m => m.length > 0)

    return matches;
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

    const messages : Message[] = []

    for (const chunk of splitBodyChunks(rawBody)) {
        const match = /:::(.*?)\n([\s\S]*?):::/.exec(chunk)
        if (match) {
            messages.push(new Message({ 
                role : "assistant", 
                content : match[2].trim()
            }))
        } else {
            messages.push(new Message({
                role : "user",
                content : chunk
            }))
        }
    }

    if (messages[messages.length - 1]?.role == "user" && header.interlocutor.reminder) {
        messages[messages.length - 1].content += `\n\n${header.interlocutor.reminder}`
    }

    return { header, body : { messages }}
}
