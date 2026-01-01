import type { RootContent } from "mdast"
import { parseReferences, parseDirectives, parseBlocks, nodeContentRaw, nodeRaw } from "../parsing/markdown"
import { expandMacros } from "../parsing/macro"
import type { ToolCall } from "./tool"
import type { Macro } from "./macro"
import type { Interlocutor } from "./interlocutor"
import { deserializeCall, getSerializedCallName, isSerializedCall, Tool } from "./tool"
import { deserializeInlineAttachment, isSerializedInlineAttachment, type InlineAttachment } from "./inlineAttachment"

export type MessageLink = {
    text : string
    URI  : string
    title? : string
}

export type MessageDirective = {
    name: string
    text : string
    attributes?: Record<string, string | null | undefined>
}

// Represents a single interaction with the LLM, text first, followed by tool calls and results
export type MessageInteraction = {
    text : string
    calls: ToolCall[]
    attachments: InlineAttachment[]
}

export class UserMessage {
    content : string
    role = "user" as const

    constructor({content} : {content : string}) {
        this.content = content
    }

    containedLinks() : MessageLink[] {
        return parseReferences(this.content).map(link => ({
            text: ("children" in link) ? nodeContentRaw(link, this.content) : (link.alt || ""),
            URI: link.url,
            title: link.title === null ? undefined : link.title
        }))
    }

    containedDirectives() : MessageDirective[] {
        return parseDirectives(this.content).map(directive => ({
            text: nodeContentRaw(directive, this.content),
            name: directive.name,
            attributes: directive.attributes ? { ...directive.attributes } : {}
        }))
    }

    async expandMacros(macros : Macro[], messageEnv? : Record<string,string>) {
        if (macros.length === 0) return

        const macroByName: Record<string, Macro> = {}
        macros.forEach(m => {
            macroByName[m.name.trim().toLowerCase()] = m
        })

        this.content = await expandMacros(this.content, macroByName, messageEnv)
    }
}

export class AssistantMessage {
    content : string
    name: string
    tools: Record<string, Tool>
    role = "assistant" as const

    constructor({ content, interlocutor } : {content : string, interlocutor: Interlocutor}) {
        this.content = content
        this.name = interlocutor.name
        this.tools = interlocutor.registry ?? {}
    }

    // Parse out inline attachments and subsequent interactions
    // in a single mdast pass.
    parseAssistantContent(): { attachments: InlineAttachment[], interactions: MessageInteraction[] } {
        const raw = this.content
        const blocks = parseBlocks(raw)

        const attachments: InlineAttachment[] = [] // Legacy field, now always empty

        let curText : RootContent[] = []
        let curCalls : ToolCall[] = []
        let curAttachments: InlineAttachment[] = []
        const interactions : MessageInteraction[] = []

        const flush = () => {
            if (curText.length > 0 || curCalls.length > 0 || curAttachments.length > 0) {
                let text = ""
                if (curText.length > 0) {
                    const content_start = curText[0].position?.start.offset
                    const content_end = curText[curText.length - 1].position?.end.offset
                    text = raw.slice(content_start, content_end)
                }
                interactions.push({ text, calls: curCalls, attachments: curAttachments })
                curText = []
                curCalls = []
                curAttachments = []
            }
        }

        for (const block of blocks) {
            const blockRaw = nodeRaw(block, raw)
            if (block.type == "html" && isSerializedInlineAttachment(blockRaw)) {
                // If we have accumulated text or calls, flush them first.
                // This ensures the attachment starts a NEW interaction context
                // (as a user message injection) following the previous text.
                if (curText.length > 0 || curCalls.length > 0) {
                    flush()
                }
                curAttachments.push(deserializeInlineAttachment(blockRaw))
            } else if (block.type == "html" && isSerializedCall(blockRaw)) {
                const name = getSerializedCallName(blockRaw)
                if (!name) throw Error("Parse error for tool call: couldn't parse name")
                const call = deserializeCall(this.tools[name] ?? null, blockRaw)
                if (call === null) throw Error("Parse error for tool call: couldn't deserialize call")
                curCalls.push(call)
            } else {
                if (curCalls.length !== 0) flush()
                curText.push(block)
            }
        }

        flush()

        return { attachments, interactions }
    }


}

export type Message = UserMessage | AssistantMessage

export function isMessage(raw : unknown): raw is Message {
    return (raw instanceof UserMessage) || 
        (raw instanceof AssistantMessage)
}
