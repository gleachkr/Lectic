import { Logger } from "../logging/logger"
import { PDFDocument } from 'pdf-lib';
import type { Lectic } from "../types/lectic"
import { Hook, type HookEvents } from "../types/hook"
import type { Tool } from "../types/tool"
import type { ToolCall } from "../types/tool"
import { ToolCallResults } from "../types/tool"
import type { MessageLink } from "../types/message"
import { MessageAttachment, type MessageAttachmentPart } from "../types/attachment"
import type { UserMessage } from "../types/message"
import { MessageCommand } from "../types/directive.ts"
import type { InlineAttachment } from "../types/inlineAttachment"
import { destrictify, type JSONSchema } from "../types/schema.ts";

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

function parseHookOutput(text: string): { content: string, attributes: Record<string, string> } {
    const lines = text.split('\n')
    const attributes: Record<string, string> = {}
    let headerEnd = 0
    
    // Parse headers until blank line or non-header
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i]
        const match = /^LECTIC:([A-Za-z0-9_-]+)(?::(.*))?$/.exec(line)
        if (match) {
            attributes[match[1].toLowerCase()] = match[2] ?? "true"
            headerEnd = i + 1
        } else {
            if (line.trim().length === 0 && Object.keys(attributes).length > 0) {
                headerEnd = i + 1
            } 
            break 
        } 
    }
    
    const content = lines.slice(headerEnd).join('\n')
    return { content, attributes }
}

export function runHooks(
    hooks: Hook[],
    event: keyof HookEvents,
    env: Record<string, string>,
    stdin? : string
): InlineAttachment[] {
    const inline: InlineAttachment[] = []
    
    const active = hooks.filter(h => h.on.includes(event))

    for (const hook of active) {
        try {
            const { output } = hook.execute(env, stdin)
            if (output && output.trim().length > 0) {
                 const { content, attributes } = parseHookOutput(output)
                 inline.push({
                     kind: "hook",
                     command: hook.do,
                     content: content,
                     mimetype: "text/plain",
                     attributes: Object.keys(attributes).length > 0 ? attributes : undefined
                 })
            }
        } catch (e) {
            Logger.debug(`An error occurred during the hook execution of ${hook.do}`, e)
        }
    }
    return inline
}

export function emitAssistantMessageEvent(
    text : string | undefined | null, 
    lectic: Lectic,
    opt?: { 
        toolUseDone?: boolean, 
        usage?: { input: number, cached: number, output: number, total: number },
        loopCount?: number,
        finalPassCount?: number
    }
) {
    const baseEnv: Record<string, string> = {
        LECTIC_INTERLOCUTOR: lectic.header.interlocutor.name,
        LECTIC_MODEL: lectic.header.interlocutor.model ?? "default"
    }
    if (text) { baseEnv["ASSISTANT_MESSAGE"] = text }
    if (opt?.toolUseDone) { baseEnv["TOOL_USE_DONE"] = "1" }
    if (opt?.usage) {
        baseEnv["TOKEN_USAGE_INPUT"] = opt.usage.input.toString()
        baseEnv["TOKEN_USAGE_OUTPUT"] = opt.usage.output.toString()
        baseEnv["TOKEN_USAGE_TOTAL"] = opt.usage.total.toString()
        baseEnv["TOKEN_USAGE_CACHED"] = opt.usage.cached.toString()
    }
    if (opt?.loopCount !== undefined) {
        baseEnv["LOOP_COUNT"] = opt.loopCount.toString()
    }
    if (opt?.finalPassCount !== undefined) {
        baseEnv["FINAL_PASS_COUNT"] = opt.finalPassCount.toString()
    }

    const all_hooks = lectic.header.hooks.concat(lectic.header.interlocutor.active_hooks ?? [])
    return runHooks(all_hooks, "assistant_message", baseEnv, lectic.body.snapshot({ closeBlock: true }))
}

export function emitUserMessageEvent(
    text : string | undefined | null, 
    lectic: Lectic,
) {
    const baseEnv: Record<string, string> = {
        LECTIC_INTERLOCUTOR: lectic.header.interlocutor.name,
        LECTIC_MODEL: lectic.header.interlocutor.model ?? "default"
    }
    if (text) { baseEnv["USER_MESSAGE"] = text }

    const all_hooks = lectic.header.hooks.concat(lectic.header.interlocutor.active_hooks ?? [])
    return runHooks(all_hooks, "user_message", baseEnv)
}

export type ToolRegistry = Record<string, Tool>

function isRecord(x: unknown): x is Record<string, unknown> {
    return typeof x === 'object' && x !== null && !Array.isArray(x)
}

export type ToolCallEntry = { id?: string, name: string, args: unknown }

export async function resolveToolCalls(
    entries: ToolCallEntry[],
    registry: ToolRegistry,
    opt?: { limitExceeded?: boolean, lectic?: Lectic }
): Promise<ToolCall[]> {
    const limitMsg = "Tool usage limit exceeded, no further tool calls will be allowed"
    const invalidArgsMsg = "The tool input isn't the right type. Tool inputs need to be returned as objects."
    const global_hooks = opt?.lectic?.header.hooks ?? []
    const interlocutor_hooks = opt?.lectic?.header.interlocutor.active_hooks ?? []
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
                const hooks = [...global_hooks, ...interlocutor_hooks, ...registry[name].hooks]
                const args = e.args
                if (hooks) {
                     const activeHooks = hooks.filter(h => h.on.includes("tool_use_pre"))
                     for (const hook of activeHooks) {
                         const hookEnv = {
                             TOOL_NAME: name,
                             TOOL_ARGS: JSON.stringify(args)
                         }
                         const { exitCode } = hook.execute(hookEnv)
                         if (exitCode !== 0) {
                             throw new Error("Tool use permission denied")
                         }
                     }
                }
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
