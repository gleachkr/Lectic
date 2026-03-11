import type { RootContent } from "mdast"
import {
  parseReferences,
  parseDirectives,
  parseBlocks,
  nodeContentRaw,
  nodeRaw,
  stripCommentNodes,
  isHtmlComment,
} from "../parsing/markdown"
import {
  expandMacrosWithAttachments,
  type MacroMessageEnv,
  type MacroSideEffect,
} from "../parsing/macro"
import type { ToolCall } from "./tool"
import type { Macro } from "./macro"
import type { Interlocutor } from "./interlocutor"
import { deserializeCall, getSerializedCallName, isSerializedCall, type Tool } from "./tool"
import {
  deserializeInlineAttachment,
  isSerializedInlineAttachment,
  type InlineAttachment,
} from "./inlineAttachment"
import type { MessageLink } from "./link"
import {
  deserializeThoughtBlock,
  isSerializedThoughtBlock,
  type ThoughtBlock,
} from "./thought"

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
    thoughts: ThoughtBlock[]
}

export class UserMessage {
    raw : string
    content : string
    role = "user" as const
    inlineAttachments: InlineAttachment[] = []
    macroSideEffects: MacroSideEffect[] = []

    constructor({content, raw} : {content : string, raw?: string}) {
        this.raw = raw ?? content
        this.content = stripCommentNodes(content)
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
    raw : string
    content : string
    name: string
    tools: Record<string, Tool>
    role = "assistant" as const

    constructor({ content, raw, interlocutor } : {
        content : string,
        raw?: string,
        interlocutor: Interlocutor,
    }) {
        this.raw = raw ?? content
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
        let curThoughts: ThoughtBlock[] = []
        const interactions : MessageInteraction[] = []

        const buildText = (blocks: RootContent[]) => {
            let text = ""
            let cursor: number | null = null

            for (const block of blocks) {
                const start = block.position?.start.offset
                const end = block.position?.end.offset
                if (typeof start !== "number" || typeof end !== "number") {
                    continue
                }

                if (cursor !== null)  text += raw.slice(cursor, start)

                if (!isHtmlComment(nodeRaw(block, raw))) text += nodeRaw(block, raw)

                cursor = end
            }

            return text
        }

        const flush = () => {
            if (
              curText.length > 0 ||
              curCalls.length > 0 ||
              curAttachments.length > 0 ||
              curThoughts.length > 0
            ) {
                interactions.push({
                  text: buildText(curText),
                  calls: curCalls,
                  attachments: curAttachments,
                  thoughts: curThoughts,
                })
                curText = []
                curCalls = []
                curAttachments = []
                curThoughts = []
            }
        }

        // Grouping rules:
        //
        // - Attachments start a new interaction (they become
        //   user-injected context), so any accumulated text,
        //   calls, or thoughts flush first.
        //
        // - Tool calls and thought blocks accumulate together
        //   in the current interaction. When plain text follows
        //   them, we flush to start a new text run.
        //
        // - Consecutive text nodes accumulate without flushing.

        for (const block of blocks) {
            const blockRaw = nodeRaw(block, raw)

            if (block.type === "html" && isSerializedInlineAttachment(blockRaw)) {
                if (
                  curText.length > 0 ||
                  curCalls.length > 0 ||
                  curThoughts.length > 0
                ) {
                    flush()
                }
                curAttachments.push(deserializeInlineAttachment(blockRaw))
            } else if (block.type === "html" && isSerializedCall(blockRaw)) {
                const name = getSerializedCallName(blockRaw)
                if (!name) throw Error("Parse error for tool call: couldn't parse name")
                const call = deserializeCall(this.tools[name] ?? null, blockRaw)
                if (call === null) throw Error("Parse error for tool call: couldn't deserialize call")
                curCalls.push(call)
            } else if (block.type === "html" && isSerializedThoughtBlock(blockRaw)) {
                curThoughts.push(deserializeThoughtBlock(blockRaw))
            } else {
                if (curCalls.length !== 0 || curThoughts.length !== 0) flush()
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
