import { Lectic } from "./types/lectic"

function getYaml(raw:string) : string | null {
    let expr = /^---(.*)---/m
    let match = expr.exec(raw)
    if (match?.[1]) {
        return match[1]
    } else {
        return null
    }
}

function getBody(raw:string) : string | null {
    let expr = /^---.*---(.*)$/m
    let match = expr.exec(raw)
    if (match?.[1]) {
        return match[1]
    } else {
        return null
    }
}

function splitBodyChunks(input: string): string[] {
    const pattern = /:::\s?.*?\n([\s\S]*?)(?=:::\s|$)/g;
    const matches: string[] = [];
    let match: string[] | null;

    while ((match = pattern.exec(input)) !== null) {
        matches.push(match[1].trim());
    }

    return matches;
}

export function parseLectic(raw: string) : Lectic | Error {
    const rawYaml = getYaml(raw)
    if (!rawYaml) return Error('could not parse YAML header')
        const rawBody = getBody(raw)
    if (!rawBody) return Error('could not parse Lectic Body')
}
