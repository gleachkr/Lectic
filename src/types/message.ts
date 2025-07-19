import type { RootContent } from "mdast"
import { parseReferences, parseDirectives, parseBlocks, nodeContentRaw, nodeRaw } from "../parsing/markdown"
import type { ToolCall } from "./tool"
import type { Interlocutor } from "./interlocutor"
import { deserializeCall, getSerializedCallName, isSerializedCall, Tool } from "./tool"

export type MessageLink = {
    text : string
    URI  : string
    title? : string
}

export type MessageDirective = {
    name: string
    text : string
    attributes?: { [key: string] : string | null | undefined }
}

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
        return parseDirectives(this.content).map(directive => {
            return {
            text: nodeContentRaw(directive, this.content),
            name: directive.name,
            attributes: directive.attributes ? { ...directive.attributes } : {}
        }})
    }
}

export class AssistantMessage {
    content : string
    name: string
    tools: { [key : string] : Tool }
    role = "assistant" as const

    constructor({ content, interlocutor } : {content : string, interlocutor: Interlocutor}) {
        this.content = content
        this.name = interlocutor.name
        this.tools = interlocutor.registry ?? {}
    }

    containedInteractions() : MessageInteraction[] {
        const blocks = parseBlocks(this.content)
        let curText : RootContent[] = []
        let curCalls : ToolCall[] = []
        const interactions : MessageInteraction[] = []

        const flush = () => {
            if (curText.length > 0 || curCalls.length > 0) {
                let text = "";
                if (curText.length > 0) {
                    const content_start = curText[0].position?.start.offset;
                    const content_end = curText[curText.length - 1].position?.end.offset;
                    text = this.content.slice(content_start, content_end);
                }
                interactions.push({ text, calls: curCalls });
                curText = [];
                curCalls = [];
            }
        };

        // BUG: a tool call will not necessarily be a single markdown block, because the
        // result might contain blank lines, which end an HTML block.
        for (const block of blocks) {
            const blockRaw = nodeRaw(block, this.content)
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

        return interactions
    }

}

export type Message = UserMessage | AssistantMessage

export function isMessage(raw : unknown): raw is Message {
    return (raw instanceof UserMessage) || 
        (raw instanceof AssistantMessage)
}
