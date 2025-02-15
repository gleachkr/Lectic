import Anthropic from '@anthropic-ai/sdk';
import { Message } from "../types/message"
import type { MessageLink } from "../types/message"
import type { Lectic } from "../types/lectic"
import { LLMProvider } from "../types/provider"
import type { Backend } from "../types/backend"
import type { BunFile } from "bun"

function getText(msg : Anthropic.Messages.Message) : string {
    if (msg.content.length == 0) {
        return "…"
    }

    if (msg.content[0].type == "text") {
        return msg.content[0].text
    }

    return `Unhandled Message Type: ${msg.content[0].type}`
}

class AnthropicFile {
    file : BunFile
    title : string

    constructor(link : MessageLink) {
        this.file = Bun.file(link.URI)
        this.title = link.text
    }

    async exists() : Promise<boolean> {
        return this.file.exists()
    }

    async toSource() {
        const bytes = await this.file.bytes()
        const media_type = this.file.type.replace(/^text\/.+$/,"text/plain")
        switch(media_type) {
            case "image/gif" : 
            case "image/jpeg": 
            case "image/webp": 
            case "image/png": return {
                type : "image",
                source : {
                    "type" : "base64",
                    "media_type" : media_type,
                    "data" : Buffer.from(bytes).toString("base64")
                }
            } as const
            case "application/pdf" : return {
                type : "document", 
                title : this.title,
                source : {
                    "type" : "base64",
                    "media_type" : "application/pdf",
                    "data" : Buffer.from(bytes).toString("base64")
                }
            } as const
            default: 
            case "text/plain" : return {
                type : "document", 
                title : this.title,
                source : {
                    "type" : "text",
                    "media_type" : "text/plain",
                    "data" : Buffer.from(bytes).toString()
                }
            } as const
        }
    }
}

async function handleMessage(msg : Message) : Promise<Anthropic.Messages.MessageParam> {
    const links = msg.containedLinks()
    if (links.length == 0 || msg.role != "user") {
        return msg
    } else {
        const content : Anthropic.Messages.ContentBlockParam[] = [{
            type: "text" as "text",
            text: msg.content
        }]
        for (const link of links) {
            const file = new AnthropicFile(link)
            const exists = await file.exists()
            if (exists) {
                const source = await file.toSource()
                if (source) content.push(source)
            }
        }
        return { role : msg.role, content }
    }
}

const systemPrompt = (lectic : Lectic) => `
Your name is ${lectic.header.interlocutor.name}

${lectic.header.interlocutor.prompt}

Use unicode rather than latex for mathematical notation. 

Line break at around 78 characters except in cases where this harms readability.`

export const AnthropicBackend : Backend & { client : Anthropic } = {
    async nextMessage(lectic : Lectic) : Promise<Message> {

      const messages : Anthropic.Messages.MessageParam[] = []

      for (const msg of lectic.body.messages) {
          messages.push(await handleMessage(msg))
      }

      const msg = await (this.client as Anthropic).messages.create({
        max_tokens: 1024,
        system: systemPrompt(lectic),
        messages: messages,
        model: 'claude-3-5-sonnet-latest',
      });

      return new Message({
          role: "assistant", 
          content: getText(msg)
      })
    },

    provider : LLMProvider.Anthropic,

    client : new Anthropic({
        apiKey: process.env['ANTHROPIC_API_KEY'], // TODO api key on cli or in lectic
    }),
}
