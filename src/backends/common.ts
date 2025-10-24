import { PDFDocument } from 'pdf-lib';
import type { Lectic } from "../types/lectic"
import { Hook } from "../types/hook"
import type { Tool } from "../types/tool"
import type { ToolCall } from "../types/tool"
import { ToolCallResults } from "../types/tool"

export function wrapText({text, name} : { text : string, name: string}) {
    return `<speaker name="${name}">${text}</speaker>`
}

export function systemPrompt(lectic : Lectic) {

return `Your name is ${lectic.header.interlocutor.name}

${lectic.header.interlocutor.prompt}

1. **IMPORTANT: You must write text so that each line is no longer than 78 characters.**

2. If a sentence or phrase exceeds the 78 character limit, wrap it to the next line. 

For example:

This is an example of how your response should be formatted. Notice how the 
lines break at around 78 characters, ensuring a consistent and readable layout. 
This formatting must be applied to all of your responses.

3. Use Unicode rather than LaTeX for mathematical notation.`

}

export async function pdfFragment(
    bytes : Uint8Array<ArrayBufferLike>,
    fragment : URLSearchParams) : Promise<Uint8Array<ArrayBufferLike>> {
        let startPage = 1
        let endPage = 1
        const pagesParam = fragment.get("pages")
        const pageParam = fragment.get("page")
        if (pagesParam) {
            const matches = /^(\d*)-(\d*)$/.exec(pagesParam)
            if (matches) { 
                startPage = parseInt(matches[1])
                endPage = parseInt(matches[2])
            } else {
                throw Error(`Could not read pages parameter ${pagesParam}. ` +
                            `Needs to be a pair of numbers separated by a dash.`)
            }
        } else if (pageParam) {
            const match = /^(\d*)$/.exec(pageParam)
            if (match) { 
                startPage = parseInt(match[1])
                endPage = parseInt(match[1])
            } else {
                throw Error(`Could not read page parameter ${pageParam}. ` +
                            `Needs to be a number.`)
            }
        } else {
            return bytes
        }
        const range = Array.from(
            { length: endPage - startPage + 1 },
            (_, i) => startPage - 1 + i
        )
        const origPDF= await PDFDocument.load(bytes)
        const newPDF = await PDFDocument.create()
        const pages = await newPDF.copyPages(origPDF, range)
        pages.forEach(page => newPDF.addPage(page))
        return await newPDF.save()
}

export function emitAssistantMessageEvent(text : string | undefined | null, name : string) {
    if (text && text.length > 0) {
        Hook.events.emit("assistant_message", { 
            ASSISTANT_MESSAGE: text,
            LECTIC_INTERLOCUTOR: name
        })
    }
}

export type ToolRegistry = Record<string, Tool>

function isRecord(x: unknown): x is Record<string, any> {
    return typeof x === 'object' && x !== null && !Array.isArray(x)
}

export type ToolCallEntry = { id?: string, name: string, args: unknown }

export async function resolveToolCalls(
    entries: ToolCallEntry[],
    registry: ToolRegistry,
    opt?: { limitExceeded?: boolean }
): Promise<ToolCall[]> {
    const limitMsg = "Tool usage limit exceeded, no further tool calls will be allowed"
    const invalidArgsMsg = "The tool input isn't the right type. Tool inputs need to be returned as objects."
    const results: ToolCall[] = []
    for (const e of entries) {
        const id = e.id
        const name = e.name
        if (opt?.limitExceeded) {
            const args = isRecord(e.args) ? e.args : {}
            results.push({ name, args, id, isError: true, results: ToolCallResults(limitMsg) })
            continue
        }
        if (!isRecord(e.args)) {
            results.push({ name, args: {}, id, isError: true, results: ToolCallResults(invalidArgsMsg) })
            continue
        }
        if (name in registry) {
            try {
                const args = e.args
                const r = await registry[name].call(args)
                results.push({ name, args, id, isError: false, results: r })
            } catch (error) {
                const msg = error instanceof Error 
                    ? error.message 
                    : `An error of unknown type occurred during a call to ${name}`
                const args = e.args
                results.push({ name, args, id, isError: true, results: ToolCallResults(msg) })
            }
        } else {
            const args = e.args
            results.push({ name, args, id, isError: true, results: ToolCallResults(`Unrecognized tool name: ${name}`) })
        }
    }
    return results
}
