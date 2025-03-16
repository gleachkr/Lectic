import Anthropic from '@anthropic-ai/sdk';
import { Message } from "../types/message"
import type { Lectic } from "../types/lectic"
import { LLMProvider } from "../types/provider"
import type { Backend } from "../types/backend"
import { FileLink } from "../types/link.ts"
import { Logger } from "../logging/logger"
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
        case "text/plain" : return {
            type : "document", 
            title : link.title,
            source : {
                "type" : "text",
                "media_type" : "text/plain",
                "data" : Buffer.from(bytes).toString()
            }
        } as const
        default : return {
            type: "text",
            text: `<error>Media type ${media_type} is not supported.</error>` 
        } as const
    }
}

async function handleMessage(msg : Message) : Promise<Anthropic.Messages.MessageParam> {
    const links = msg.containedLinks().flatMap(FileLink.fromGlob)
    if (links.length == 0 || msg.role != "user") {
        return msg
    } else {
        const content : Anthropic.Messages.ContentBlockParam[] = [{
            type: "text" as "text",
            text: msg.content
        }]
        for (const link of links) {
            const exists = await link.exists()
            if (exists) {
                try {
                    const source = await linkToContent(link)
                    if (source) content.push(source)
                } catch (e) {
                    content.push({
                        type: "text",
                        text: `<error>Something went wrong while retrieving ${link.title} from ${link.URI}:${(e as Error).message}</error>`
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

    let recur = 0

    while (message.stop_reason == "tool_use") {
        recur++

        if (recur > 12) {
            return new Message({
                role: "assistant", 
                content: "<error>Runaway tool use!</error>"
            })
        }

        messages.push({
            role: "assistant",
            content: message.content
        })

        const content: Anthropic.Messages.ToolResultBlockParam[] = []

        for (const block of message.content) {
            if (block.type == "tool_use") {
                if (recur > 10) {
                    content.push({
                        type : "tool_result",
                        tool_use_id : block.id,
                        content: "Tool usage limit exceeded, no further tool calls will be allowed",
                        is_error: true,
                    })
                } else
                    if (block.name in ToolRegistry) {
                        // TODO error handling
                        await ToolRegistry[block.name].call(block.input)
                        .then(rslt => content.push({
                            type : "tool_result",
                            tool_use_id : block.id,
                            content : rslt,
                        })).catch((e : Error) => content.push({
                            type : "tool_result",
                            tool_use_id : block.id,
                            content: e.message,
                            is_error: true,
                        }))
                    }
            }
        }

        messages.push({ role: "user", content })

        Logger.debug("anthropic - messages (tool)", messages)

        message = await (client as Anthropic).messages.create({
            max_tokens: 1024,
            system: systemPrompt(lectic),
            messages: messages,
            model: lectic.header.interlocutor.model ?? 
                'claude-3-7-sonnet-latest',
            tools: getTools()
        });

        Logger.debug("anthropic - reply (tool)", message)

    }

    return new Message({
        role: "assistant", 
        content: getText(message)
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

      Logger.debug("anthropic - messages", messages)

      let msg = await this.client.messages.create({
        system: systemPrompt(lectic),
        messages: messages,
        model: lectic.header.interlocutor.model ?? 'claude-3-7-sonnet-latest',
        temperature: lectic.header.interlocutor.temperature,
        max_tokens: lectic.header.interlocutor.max_tokens || 1024,
        tools: getTools()
      });

      Logger.debug("anthropic - reply", msg)

    if (msg.stop_reason == "tool_use") {
            return handleToolUse(msg, messages, lectic, this.client)
        } else {
            return new Message({
                role: "assistant",
                content: getText(msg)
            })
        }
    },

    client : new Anthropic({
        apiKey: process.env['ANTHROPIC_API_KEY'], // TODO api key on cli or in lectic
    }),

    provider : LLMProvider.Anthropic,

}
