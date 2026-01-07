import { PDFDocument } from "pdf-lib"
import type { Lectic } from "../types/lectic"
import type { Tool, ToolCall } from "../types/tool"
import type { MessageLink, UserMessage } from "../types/message"
import { MessageAttachment, type MessageAttachmentPart, } from "../types/attachment"
import { MessageCommand } from "../types/directive.ts"
import type { InlineAttachment } from "../types/inlineAttachment"
import { destrictify, type JSONSchema } from "../types/schema.ts"

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

// Decide whether a mimetype should be treated as an attachment (binary-ish)
// rather than inline text. We special-case PDF.
export function isAttachmentMime(mt: string | null | undefined): boolean {
    if (!mt) return false
    if (mt.startsWith("image/")) return true
    if (mt.startsWith("audio/")) return true
    if (mt.startsWith("video/")) return true
    if (mt === "application/pdf") return true
    return false
}

// Build MessageLink objects (title + URI) for non-text results.
export function buildNonTextResultMessageLinks(calls: ToolCall[]): MessageLink[] {
    const out: MessageLink[] = []
    for (const call of calls) {
        for (const r of call.results) {
            if (isAttachmentMime(r.mimetype)) {
                const uri = r.content.trim()
                if (uri.length > 0) {
                    out.push({ text: `${call.name} (${r.mimetype})`, URI: uri })
                }
            }
        }
    }
    return out
}

// Generic helper: from ToolCall[] collect provider-specific content parts
// for non-text results by reading the linked MessageAttachments and
// converting their parts with the provided mapper.
export async function collectAttachmentPartsFromCalls<T>(
    calls: ToolCall[],
    mapper: (part: MessageAttachmentPart) => Promise<T | null>,
): Promise<T[]> {
    const links = buildNonTextResultMessageLinks(calls)
    const out: T[] = []
    const atts = links.map(link => new MessageAttachment(link))
    for (const att of atts) {
        if (await att.exists()) {
            const parts = await att.getParts()
            for (const p of parts) {
                const blk = await mapper(p)
                if (blk) out.push(blk)
            }
        }
    }
    return out
}

export async function gatherMessageAttachmentParts(
  msg: UserMessage
): Promise<MessageAttachmentPart[]> {
  const links = msg.containedLinks().flatMap(MessageAttachment.fromGlob)
  const parts: MessageAttachmentPart[] = []
  for await (const link of links) {
    if (await link.exists()) {
      parts.push(...await link.getParts())
    }
  }
  return parts
}

export async function computeCmdAttachments(msg: UserMessage): Promise<{
  textBlocks: string[]
  inline: InlineAttachment[]
}> {
  const textBlocks: string[] = []
  const inline: InlineAttachment[] = []
  const commands = msg.containedDirectives().map((d) => new MessageCommand(d))
  for (const command of commands) {
    const result = await command.execute()
    if (result) {
      textBlocks.push(result)
      inline.push({
        kind: "cmd",
        command: command.command,
        content: result,
        mimetype: "text/plain",
      })
    }
  }
  return { textBlocks, inline }
}

export function destrictifyToolResults(tool : Tool | null, values : string) : unknown {
    let args: unknown
    if (tool) {
        try { args = JSON.parse(values) } catch { args = undefined }
        const toolSchema: JSONSchema = {
            type: "object",
            properties: tool.parameters,
            required: tool.required,
        }
        args = destrictify(args, toolSchema)
    } 
    return args
}
