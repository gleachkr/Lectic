import type { MessageLink } from "../types/message"
import type { BunFile } from "bun"
import { $ } from "bun"

export class FileLink {
    file : BunFile | undefined
    response : Promise<Response> | undefined
    result : Promise<String> | undefined
    title : string

    constructor(link : MessageLink) {
        try {
            const url = new URL(link.URI)
            switch(url.protocol) {
                case "file:" : {
                    this.file = Bun.file(Bun.fileURLToPath(link.URI)); break
                }
                case "http:" :
                case "https:" : {
                    this.response = Bun.fetch(link.URI)
                }
            }
        } catch {
            if (link.URI[0] == "$") {
                this.result = $`${link.URI.substring(1).trim()}`.text()
            } else {
                this.file = Bun.file(link.URI)
            }
        }
        this.title = link.text
    }

    async exists() : Promise<boolean> {
        if (this.response) return true
        if (this.file?.exists()) return true
        return false
    }

    async getType() {
        if (this.file) {
            return this.file.type.replace(/^text\/.+$/,"text/plain")
        } else if (this.response) {
            const headers = (await this.response).headers
            return headers.get("Content-Type")?.replace(/^text\/.+$/,"text/plain")
        } else if (this.result) {
            return "text/plain"
        }
        return null
    }

    async getBytes() {
        if (this.file) {
            return this.file.bytes()
        } else if (this.response) {
            // this is probably unnecessary, but typescript LSP doesn't seem to
            // recognize Bun's Response.bytes()
            return (await (await this.response).blob()).bytes()
            // TODO error handling in case of a failed fetch
        } else if (this.result) {
            return this.result.then(rslt => Buffer.from(rslt))
        }
        return null
    }

}
