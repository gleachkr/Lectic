import Anthropic from '@anthropic-ai/sdk';
import { Message } from "../types/message"
import type { Lectic } from "../types/lectic"
import { LLMProvider } from "../types/provider"
import type { Backend } from "../types/backend"
import { FileLink } from "../types/link.ts"
import { initRegistry, ToolRegistry } from "../types/tool_spec"
import { systemPrompt } from "./util"

function getText(msg : Anthropic.Messages.Message) : string {
    if (msg.content.length == 0) {
        return "…"
    } else {
        let rslt = ""
        for (const block of msg.content) {
            if (block.type == "text") {
                rslt += block.text
            }
        }
        return rslt
    }
}

async function linkToContent(link : FileLink) {
    const media_type = await link.getType()
    const bytes = await link.getBytes()
    if (!(media_type && bytes)) return null
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
            title : link.title,
            source : {
                "type" : "base64",
                "media_type" : "application/pdf",
                "data" : Buffer.from(bytes).toString("base64")
            }
        } as const
        default: 
        case "text/plain" : return {
            type : "document", 
            title : link.title,
            source : {
                "type" : "text",
                "media_type" : "text/plain",
                "data" : Buffer.from(bytes).toString()
            }
        } as const
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
            const file = new FileLink(link)
            const exists = await file.exists()
            if (exists) {
                try {
                    const source = await linkToContent(file)
                    if (source) content.push(source)
                } catch (e) {
                    content.push({
                        type: "text",
                        text: `<error>Something went wrong while retrieving ${file.title} from ${link}:${(e as Error).message}</error>`
                    })
                }
            }
        }
        return { role : msg.role, content }
    }
}


function getTools() : Anthropic.Messages.Tool[] {
    const tools : Anthropic.Messages.Tool[] = []
    for (const tool of Object.values(ToolRegistry)) {
        tools.push({
            name : tool.name,
            description : tool.description,
            input_schema : {
                "type" : "object",
                "properties" : tool.parameters
            }
        })
    }
    return tools
}

async function handleToolUse(
    message: Anthropic.Messages.Message, 
    messages : Anthropic.Messages.MessageParam[], 
    lectic : Lectic,
    client : Anthropic) : Promise<Message> {

    let text_results = ""

    for (let max_recur = 10; max_recur >= 0; max_recur--) {
        if (message.stop_reason != "tool_use") break

        messages.push({
            role: "assistant",
            content: message.content
        })

        const tool_results : Anthropic.Messages.ToolResultBlockParam[] = []

        for (const block of message.content) {
            if (block.type == "tool_use") {
                if (block.name in ToolRegistry) {
                    // TODO error handling
                    await ToolRegistry[block.name].call(block.input)
                        .then(rslt => tool_results.push({
                                type : "tool_result",
                                tool_use_id : block.id,
                                content : rslt,
                        })).catch((e : Error) => tool_results.push({
                                type : "tool_result",
                                tool_use_id : block.id,
                                content: e.message,
                                is_error: true,
                        }))
                }
            }
        }

        messages.push({
            role: "user",
            content: tool_results
        })

        text_results += `${getText(message)}\n\n`

        message = await (client as Anthropic).messages.create({
            max_tokens: 1024,
            system: systemPrompt(lectic),
            messages: messages,
            model: lectic.header.interlocutor.model ?? 
                'claude-3-7-sonnet-latest',
            tools: getTools()
        });
    }

    return new Message({
        role: "assistant", 
        content: text_results + getText(message)
    })
}

export const AnthropicBackend : Backend & { client : Anthropic } = {

    async nextMessage(lectic : Lectic) : Promise<Message> {

      if (lectic.header.interlocutor.tools) {
        initRegistry(lectic.header.interlocutor.tools)
      }

      const messages : Anthropic.Messages.MessageParam[] = []

      for (const msg of lectic.body.messages) {
          messages.push(await handleMessage(msg))
      }

      let msg = await this.client.messages.create({
        system: systemPrompt(lectic),
        messages: messages,
        model: lectic.header.interlocutor.model ?? 'claude-3-7-sonnet-latest',
        temperature: lectic.header.interlocutor.temperature,
        max_tokens: lectic.header.interlocutor.max_tokens || 1024,
        tools: getTools()
      });

      return handleToolUse(msg, messages, lectic, this.client)
    },

    client : new Anthropic({
        apiKey: process.env['ANTHROPIC_API_KEY'], // TODO api key on cli or in lectic
    }),

    provider : LLMProvider.Anthropic,

}
