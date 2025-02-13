import { Lectic, Message, isLecticHeader } from "./types/lectic"
import * as YAML from "yaml"

export function getYaml(raw:string) : string | null {
    let expr = /^---\n([\s\S]*?)\n---/m
    let match = expr.exec(raw)
    if (match?.[1]) {
        return match[1]
    } else {
        return null
    }
}

export function getBody(raw:string) : string | null {
    let expr = /^---[\s\S]*?---([\s\S]*)$/m
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

export function parseLectic(raw: string) : Lectic | Error {
    const rawYaml = getYaml(raw)
    const rawBody = getBody(raw)

    if (!rawYaml) return Error('could not parse YAML header')
    if (!rawBody) return Error('could not parse Lectic Body')

    const header: unknown = YAML.parse(rawYaml)

    if (!isLecticHeader(header)) return Error("YAML Header contains either unrecognized fields or is missing a field")

    const messages : Message[] = []

    for (const chunk of splitBodyChunks(rawBody)) {
        const match = /:::(.*?)\n([\s\S]*?):::/.exec(chunk)
        if (match) {
            messages.push({
                role: "assistant",
                content: match[2].trim(),
            })
        } else {
            messages.push({
                role: "user",
                content: chunk,
            })
        }
    }

    return { header, body : {messages}}
}
