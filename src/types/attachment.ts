import type { MessageLink } from "./message"
import type { BunFile } from "bun"
import { Glob } from "bun"
import { MCPTool } from "../tools/mcp.ts"
import type { ReadResourceResult } from "@modelcontextprotocol/sdk/types.js"

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
                case "https:" : {
                    this.response = Bun.fetch(link.URI); break
                }
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

    async getType() : Promise<string | null > {
        if (this.file) {
            return this.file.type.replace(/^text\/.+$/,"text/plain")
        } else if (this.response) {
            const headers = (await this.response).headers
            return headers.get("Content-Type")?.replace(/^text\/.+$/,"text/plain") ?? null
        } else if (this.resource) {
            const resource = (await this.resource) 
            return resource.contents[0].mimeType || "application/octet-stream"
        }
        return null
    }

    async getBytes() : Promise<Uint8Array | null>{
        if (this.file) {
            return this.file.bytes()
        } else if (this.response) {
            // this is probably unnecessary, but typescript LSP doesn't seem to
            // recognize Bun's Response.bytes()
            return (await (await this.response).blob()).bytes()
            // TODO error handling in case of a failed fetch
        } else if (this.resource) {
            const contents = (await this.resource).contents[0]
            if (contents.blob) {
                return Uint8Array.fromBase64(contents.blob as string)
            } else {
                return Buffer.from(contents.text as string)
            }
        }
        return null
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
            return files.map(file => new MessageAttachment({text: link.text, URI: file}))
        }
    }
}
