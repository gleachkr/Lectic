import { expandEnv} from "../utils/replace.ts"
import type { MessageLink } from "./message"
import type { BunFile } from "bun"
import { Glob } from "bun"
import { MCPTool } from "../tools/mcp.ts"
import type { ReadResourceResult } from "@modelcontextprotocol/sdk/types.js"

type MessagePartOpts = {
    bytes : Uint8Array
    mimetype : string | null
    title : string 
    URI : string 
    fragmentParams: URLSearchParams | undefined
}

export class MessageAttachmentPart {
    bytes : Uint8Array
    mimetype: string | null
    fragmentParams: URLSearchParams | undefined
    title: string 
    URI: string 

    constructor(opts : MessagePartOpts ) {
        this.bytes = opts.bytes
        this.mimetype = opts.mimetype
        this.fragmentParams = opts.fragmentParams
        this.title = opts.title
        this.URI = opts.URI
    }
}

function parseDataUrl(uri: string): { mime: string, bytes: Uint8Array } {
    // data:[<mediatype>][;base64],<data>
    const comma = uri.indexOf(",")
    if (comma < 0) throw new Error("Malformed data URL: missing comma")
    const header = uri.slice(5, comma) // strip "data:"
    const dataPart = uri.slice(comma + 1)
    const parts = header.split(";").filter((s) => s.length > 0)
    const hasBase64 = parts.some((p) => p.toLowerCase() === "base64")
    const mime = (parts[0] && !parts[0].includes("="))
        ? parts[0]
        : "text/plain"
    if (hasBase64) {
        return { mime, bytes: Uint8Array.fromBase64(dataPart) }
    } else {
        const decoded = decodeURIComponent(dataPart)
        return { mime, bytes: new TextEncoder().encode(decoded) }
    }
}

export class MessageAttachment {
    file : BunFile | undefined
    response : Promise<Response> | undefined
    resource : Promise<ReadResourceResult> | undefined
    fragmentParams: URLSearchParams | undefined
    title : string
    URI : string

    constructor(link : MessageLink) {
        this.URI = expandEnv(link.URI)
        try {
            const url = new URL(this.URI)
            this.fragmentParams = new URLSearchParams(url.hash.slice(1))
            switch(url.protocol) {
                case "file:" : {
                    this.file = Bun.file(url.pathname); break
                }
                case "http:" :
                case "https:" :
                case "s3:" : {
                    this.response = Bun.fetch(url); break
                }
                case "data:" : {
                    // handled in getParts
                    break
                }
                default : {
                    // Support MCP URI form: server+type://...
                    const plusMatch = /^([^+]+)\+/.exec(url.protocol)
                    if (plusMatch && plusMatch[1] in MCPTool.clientByName) {
                        const server = plusMatch[1]
                        this.resource = MCPTool.clientByName[server].readResource({
                            uri: this.URI.slice(server.length + 1)
                        })
                    }
                }
            }
        } catch {
            this.file = Bun.file(this.URI)
        }
        this.title = link.text
    }

    async exists() : Promise<boolean> {
        // data: URIs are self-contained
        if (this.URI.startsWith("data:")) return true
        if (this.resource) return true
        if (this.response) return true
        if (this.file?.exists()) return true
        return false
    }

    async getParts() : Promise<MessageAttachmentPart[]> {
        if (this.URI.startsWith("data:")) {
            try {
                const { mime, bytes } = parseDataUrl(this.URI)
                const mimetype = mime.replace(/^text\/.+$/, "text/plain")
                return [new MessageAttachmentPart({
                    bytes,
                    mimetype,
                    URI: this.URI,
                    title: this.title,
                    fragmentParams: this.fragmentParams,
                })]
            } catch {
                // fall through to empty result on parse error
                return []
            }
        }
        if (this.file) {
            let mimetype = this.file.type.replace(/^text\/.+$/,"text/plain")
            const bytes = await this.file.bytes()
            if (mimetype === "application/octet-stream" &&
                bytes.find(x => x == 0x0) == undefined)  {
                // if there are no null bytes, it's probably not a binary. Guess text/plain
                mimetype = "text/plain"
            }
            return [new MessageAttachmentPart({
                bytes, mimetype, 
                URI : this.URI, 
                title : this.title,
                fragmentParams: this.fragmentParams
            })]
        } else if (this.response) {
            const response = await this.response
            const mimetype = response.headers.get("Content-Type")?.replace(/^text\/.+$/,"text/plain") ?? null
            const bytes = await response.bytes()
            return [new MessageAttachmentPart({
                bytes, mimetype, 
                URI : this.URI, 
                title : this.title,
                fragmentParams: this.fragmentParams
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
                    title : this.title,
                    fragmentParams: this.fragmentParams
                })
            })
        } 
        return []
    }

    static fromGlob(link : MessageLink) : MessageAttachment[] {
        let pattern = ""
        try {
            const expanded = expandEnv(link.URI)
            const url = new URL(expanded)
            if (url.protocol === "file:") {
                pattern = Bun.fileURLToPath(url)
            } else {
                return [new MessageAttachment(link)]
            }
        } catch {
            pattern = expandEnv(link.URI.replace(/^~/,"$HOME"))
        }

        const files = Array(...new Glob(pattern).scanSync())
        if (files.length < 1) {
            // No matches: return the original link; constructor will
            // perform the single authoritative expansion.
            return [new MessageAttachment(link)]
        } else {
            // Matches: pass concrete file paths (no variables) to the
            // constructor to avoid any second expansion.
            return files.map(file =>
                new MessageAttachment({ text: link.text, URI: file })
            )
        }
    }
}
