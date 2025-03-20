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

export class Message {
    role : "user" | "assistant"
    content : string

    constructor({ role, content } : {role : "user" | "assistant", content : string}) {
        this.role = role
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
            console.log(directive.children[0].position)
            console.log(this.content.length)
            return {
            text: nodeContentRaw(directive, this.content),
            name: directive.name,
            attributes: directive.attributes === null ? undefined : directive.attributes
        }})
    }
}
