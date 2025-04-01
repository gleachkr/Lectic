import type { RootContent } from "mdast"
import { parseLinks, parseDirectives, parseBlocks, nodeContentRaw, nodeRaw } from "../parsing/markdown"
import type { ToolCall } from "./tool"
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
        return parseLinks(this.content).map(link => ({
            text: nodeContentRaw(link, this.content),
            URI: link.url,
            title: link.title === null ? undefined : link.title
        }))
    }

    containedDirectives() : MessageDirective[] {
        return parseDirectives(this.content).map(directive => {
            return {
            text: nodeContentRaw(directive, this.content),
            name: directive.name,
            attributes: directive.attributes === null ? undefined : directive.attributes
        }})
    }
}

export class AssistantMessage {
    content : string
    name: string
    role = "assistant" as const

    constructor({ content, name } : {content : string, name: string}) {
        this.content = content
        this.name = name
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

        for (const block of blocks) {
            const blockRaw = nodeRaw(block, this.content)
            if (isSerializedCall(blockRaw)) {
                const name = getSerializedCallName(blockRaw)
                if (name === null) throw Error("Parse error for tool call: couldn't parse name")
                const tool = Tool.registry[name]
                const call = deserializeCall(tool, blockRaw)
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
