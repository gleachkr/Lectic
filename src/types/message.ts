import { parseLinks, parseDirectives, nodeContentRaw } from "../parsing/markdown"

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

export class UserMessage {
    content : string

    constructor({content} : {content : string}) {
        this.content = content
    }

    role = "user" as const

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

    constructor({ content } : {content : string}) {
        this.content = content
    }

    role = "assistant" as const
}

export type Message = UserMessage | AssistantMessage

export function isMessage(raw : unknown): raw is Message {
    return (raw instanceof UserMessage) || 
        (raw instanceof AssistantMessage)
}
