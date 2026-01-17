import type { RootContent } from "mdast"
import {
  parseReferences,
  parseDirectives,
  parseBlocks,
  nodeContentRaw,
  nodeRaw,
  replaceDirectives,
} from "../parsing/markdown"
import {
  expandMacrosWithAttachments,
  type MacroMessageEnv,
  type MacroSideEffect,
} from "../parsing/macro"
import type { ToolCall } from "./tool"
import type { Macro } from "./macro"
import type { Interlocutor } from "./interlocutor"
import { deserializeCall, getSerializedCallName, isSerializedCall, Tool } from "./tool"
import {
  deserializeInlineAttachment,
  isSerializedInlineAttachment,
  type InlineAttachment,
} from "./inlineAttachment"
import type { MessageLink } from "./link"

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
    inlineAttachments: InlineAttachment[] = []
    macroSideEffects: MacroSideEffect[] = []

    constructor({content} : {content : string}) {
        this.content = content
    }

    // Built-in text directives that are used for Lectic side effects
    // (running commands, switching interlocutors, etc). These directives
    // should not be forwarded to the LLM as literal text.
    static readonly BUILTIN_DIRECTIVES_TO_STRIP = [
        "cmd",
        "attach",
        "ask",
        "aside",
        "reset",
        "merge_yaml",
        "temp_merge_yaml",
    ] as const

    // Returns a clean copy of the message with built-in directives removed.
    cleanSideEffects(): UserMessage {
        const out = new UserMessage({ content: this.content })
        out.stripTextDirectives(UserMessage.BUILTIN_DIRECTIVES_TO_STRIP)
        return out
    }

    stripTextDirectives(names: readonly string[]): void {
        const wanted = new Set(names.map((n) => n.toLowerCase()))
        this.content = replaceDirectives(this.content, (name) => {
            return wanted.has(name.toLowerCase()) ? "" : null
        })
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

    async expandMacros(macros : Macro[], messageEnv? : MacroMessageEnv) {
        const macroByName: Record<string, Macro> = {}
        macros.forEach(m => {
            macroByName[m.name.trim().toLowerCase()] = m
        })

        const res = await expandMacrosWithAttachments(
          this.content,
          macroByName,
          messageEnv
        )

        this.content = res.text
        this.inlineAttachments = res.inlineAttachments
        this.macroSideEffects = res.sideEffects
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
    parseAssistantContent(): { interactions: MessageInteraction[] } {
        const raw = this.content
        const blocks = parseBlocks(raw)

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

        return { interactions }
    }


}

export type Message = UserMessage | AssistantMessage

export function isMessage(raw : unknown): raw is Message {
    return (raw instanceof UserMessage) || 
        (raw instanceof AssistantMessage)
}
