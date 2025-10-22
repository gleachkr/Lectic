import type { RootContent } from "mdast"
import { parseReferences, parseDirectives, parseBlocks, replaceDirectives, nodeContentRaw, nodeRaw } from "../parsing/markdown"
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

    async expandMacros(macros : Macro[]) {
        if (macros.length === 0) return

        const expansionMap : { [macroName : string] : string } = {}

        // We run the expansions in parallel
        await Promise.all(
            parseDirectives(this.content)
                .filter(directive => directive.name === "macro")
                .map(async directive => {
                    const macroName = nodeContentRaw(directive, this.content).trim()
                    const matched = macros.find(macro => macro.name.trim() === macroName)
                    const attributes : Record<string, string | undefined>= {}
                    for (const key in directive.attributes) {
                        if (directive.attributes[key] === null) { 
                            attributes[key] = undefined 
                        } else {
                            attributes[key] = directive.attributes[key]
                        }
                    }
                    const expansion = await matched?.expand(attributes)
                    if (typeof expansion === 'string') expansionMap[macroName] = expansion
                })
        )

        const replacer = (name: string, content:string) => {
            if (name !== "macro") return null
            const key = content.trim()
            if (!(key in expansionMap)) return null
            return expansionMap[key]
        }

        this.content = replaceDirectives(this.content, replacer)
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

    // Parse out leading inline attachments and subsequent interactions
    // in a single mdast pass. This avoids string slicing and keeps
    // positions consistent if we later allow mixing content.
    parseAssistantContent(): { attachments: InlineAttachment[], interactions: MessageInteraction[] } {
        const raw = this.content
        const blocks = parseBlocks(raw)

        const attachments: InlineAttachment[] = []
        let i = 0
        while (i < blocks.length) {
            const blockRaw = nodeRaw(blocks[i], raw)
            if (isSerializedInlineAttachment(blockRaw)) {
                attachments.push(deserializeInlineAttachment(blockRaw))
                i++
                continue
            }
            // stop on first non-attachment block
            break
        }

        let curText : RootContent[] = []
        let curCalls : ToolCall[] = []
        const interactions : MessageInteraction[] = []

        const flush = () => {
            if (curText.length > 0 || curCalls.length > 0) {
                let text = ""
                if (curText.length > 0) {
                    const content_start = curText[0].position?.start.offset
                    const content_end = curText[curText.length - 1].position?.end.offset
                    text = raw.slice(content_start, content_end)
                }
                interactions.push({ text, calls: curCalls })
                curText = []
                curCalls = []
            }
        }

        for (const block of blocks) {
            const blockRaw = nodeRaw(block, raw)
            if (isSerializedCall(blockRaw)) {
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
