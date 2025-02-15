export type MessageLink = {
    text : string
    URI  : string
}

export class Message {
    role : "user" | "assistant"
    content : string

    constructor({ role, content } : {role : "user" | "assistant", content : string}) {
        this.role = role
        this.content = content
    }

    containedLinks() : MessageLink[] {
        const linkRegex = /\[([^\]]*?)\]\((.*?)\)/g;
        const links : MessageLink[] = []
        let match;
        while ((match = linkRegex.exec(this.content)) !== null) {
            if (match[1] && match[2]) {
                links.push({
                    text : match[1],
                    URI : match[2].trim()
                })
            }
        }
        return links
    }
}
