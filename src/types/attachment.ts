import type { MessageLink } from "./message"
import type { BunFile } from "bun"
import { Glob } from "bun"
import { MCPTool } from "../tools/mcp.ts"
import type { ReadResourceResult } from "@modelcontextprotocol/sdk/types.js"

export class MessageAttachmentPart {
    bytes : Uint8Array
    mimetype: string | null
    title: string 
    URI: string 

    constructor(opts : {bytes : Uint8Array, mimetype : string | null, title : string , URI : string }) {
        this.bytes = opts.bytes
        this.mimetype = opts.mimetype
        this.title = opts.title
        this.URI = opts.URI
    }
}

export class MessageAttachment {
    file : BunFile | undefined
    response : Promise<Response> | undefined
    resource : Promise<ReadResourceResult> | undefined
    title : string
    URI : string

    constructor(link : MessageLink) {
        try {
            const url = new URL(link.URI)
            switch(url.protocol) {
                case "file:" : {
                    this.file = Bun.file(Bun.fileURLToPath(link.URI)); break
                }
                case "http:" :
                case "https:" :
                case "s3:" : {
                    this.response = Bun.fetch(link.URI); break
                }
                default : {
                    const mcp_match = /^([^+]+)\+/.exec(url.protocol)
                    if (mcp_match && mcp_match[1] in MCPTool.client_registry) {
                        MCPTool.client_registry[mcp_match[1]]
                        this.resource = MCPTool.client_registry[mcp_match[1]].readResource({
                            uri: link.URI.slice(mcp_match[1].length+1)
                        })
                    }
                }
            }
        } catch {
            this.file = Bun.file(link.URI)
        }
        this.title = link.text
        this.URI = link.URI
    }

    async exists() : Promise<boolean> {
        if (this.resource) return true
        if (this.response) return true
        if (this.file?.exists()) return true
        return false
    }

    async getParts() : Promise<MessageAttachmentPart[]> {
        if (this.file) {
            const mimetype = this.file.type.replace(/^text\/.+$/,"text/plain")
            const bytes = await this.file.bytes()
            return [new MessageAttachmentPart({
                bytes, mimetype, 
                URI : this.URI, 
                title : this.title
            })]
        } else if (this.response) {
            const response = await this.response
            const mimetype = response.headers.get("Content-Type")?.replace(/^text\/.+$/,"text/plain") ?? null
            const bytes = await response.bytes()
            return [new MessageAttachmentPart({
                bytes, mimetype, 
                URI : this.URI, 
                title : this.title
            })]
        } else if (this.resource) {
            const contents = (await this.resource).contents
            return contents.map(part => {
                const mimetype = part.text 
                    ? part.mimeType?.replace(/^text\/.+$/,"text/plain") ?? "text/plain"
                    : part.mimeType || "application/octet-stream"
                const bytes = part.blob
                    ? Uint8Array.fromBase64(part.blob as string)
                    : Buffer.from(part.text as string)
                return new MessageAttachmentPart({
                    bytes, mimetype, 
                    URI : this.URI, 
                    title : this.title
                })
            })
        } 
        return []
    }

    static fromGlob(link : MessageLink) : MessageAttachment[] {
        let path = ""
        try {
            const url = new URL(link.URI)
            if (url.protocol == "file:") {
                path = Bun.fileURLToPath(link.URI)
            } else {
                return [new MessageAttachment(link)]
            }
        } catch { 
            path = link.URI
        }
        const files = Array(...new Glob(path).scanSync())
        if (files.length < 1) {
            return [new MessageAttachment(link)]
        } else {
            return files
                .map(file => new MessageAttachment({text: link.text, URI: file}))
        }
    }
}
