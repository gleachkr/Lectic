import ollama from 'ollama'
import * as Ollama from 'ollama'
import { Message } from "../types/message"
import type { Lectic } from "../types/lectic"
import { LLMProvider } from "../types/provider"
import type { Backend } from "../types/backend"
import { FileLink } from "../types/link"
import { Logger } from "../logging/logger"
import { initRegistry, ToolRegistry } from "../types/tool_spec"
import { systemPrompt } from './util'

function getText(response : Ollama.ChatResponse) : string {
    return response.message.content ?? "…"
}

function getTools() : Ollama.Tool[] {
    const tools : Ollama.Tool[] = []
    for (const tool of Object.values(ToolRegistry)) {
        tools.push({
            type: "function",
            function: {
                name : tool.name,
                description : tool.description,
                parameters: {
                    "type" : "object",
                    "properties" : tool.parameters,
                    "required" : tool.required ?? [],
                }
            }
        })
    }
    return tools
}

async function handleToolUse(
    response : Ollama.ChatResponse, 
    messages : Ollama.Message[], 
    lectic : Lectic,
    ) : Promise<Message> {

    for (let recur = 12; recur >= 0; recur--) {
        if (!response.message.tool_calls) break

        messages.push({
            role: "assistant",
            content: response.message.content,
            tool_calls: response.message.tool_calls
        })

        for (const call of response.message.tool_calls) {
            if (recur < 2) {
                messages.push({
                    role: "tool",
                    content: "<error>Tool usage limit exceeded, no further tool calls will be allowed</error>",
                })
            } else if (call.function.name in ToolRegistry) {
                 // TODO error handling
                const inputs = call.function.arguments
                //weirdly, ollama doesn't track tool_id
                await ToolRegistry[call.function.name].call(inputs)
                    .then(rslt => messages.push({
                            role: "tool",
                            content : rslt,
                    })).catch((e : Error) => messages.push({
                            role: "tool",
                            content: `<error>An Error Occurred: ${e.message}</error>`,
                    }))
            }
        }

        Logger.log("ollama - messages", messages)

        response = await ollama.chat({
            messages: [developerMessage(lectic), ...messages],
            model: lectic.header.interlocutor.model ?? 'llama-3.2',
            tools: getTools()
        });

        Logger.log("ollama - reply (tool)", response)
    }

    return new Message({
        role: "assistant", 
        content: getText(response)
    })
}

async function linkToContent(link : FileLink) 
    : Promise<{text?: string, image_data?: string} | null> {
    const media_type = await link.getType()
    const bytes = await link.getBytes()
    if (!(media_type && bytes)) return null
    switch(media_type) {
        case "image/gif" : 
        case "image/jpeg": 
        case "image/webp": 
        case "image/png": return {
            image_data: Buffer.from(bytes).toString("base64")
        } as const
        case "application/pdf" : return {
            text: `<error>couldn't upload ${link.title}. PDFs are not currently supported</error>`
        } as const
        default: 
        case "text/plain" : return {
            text: `<file title="${link.title}">${Buffer.from(bytes).toString()}</file>`
        } as const
    }
}

async function handleMessage(msg : Message) : Promise<Ollama.Message> {
    const links = msg.containedLinks()
    if (links.length == 0 || msg.role != "user") {
        return msg
    } else {
        const images : string[] = []

        for (const link of links) {
            const file = new FileLink(link)
            const exists = await file.exists()
            if (exists) {
                try {
                    const source = await linkToContent(file)
                    if (source && source.image_data) images.push(source.image_data)
                    if (source && source.text) msg.content += source.text
                } catch (e) {
                    msg.content += 
                        `<error>Something went wrong while retrieving ${file.title} from ${link}:${(e as Error).message}</error>`
                }
            }
        }


        return { role : msg.role, content : msg.content, images : images}
    }
}

function developerMessage(lectic : Lectic): Ollama.Message {
    return {
        role : "system" as "system",
        content: systemPrompt(lectic)
    }
}

export const OllamaBackend : Backend = {

    async nextMessage(lectic : Lectic) : Promise<Message> {

      if (lectic.header.interlocutor.tools) {
        initRegistry(lectic.header.interlocutor.tools)
      }

      const messages : Ollama.Message[] = []

      for (const msg of lectic.body.messages) {
          messages.push(await handleMessage(msg))
      }

      Logger.log("ollama - messages", messages)

      let msg = await ollama.chat({
        messages: [developerMessage(lectic), ...messages],
        model: lectic.header.interlocutor.model || 'llama3.2',
        tools: getTools(),
        options: {
            temperature: lectic.header.interlocutor.temperature,
        }
      });
      
      Logger.log("ollama - reply", msg)

      return handleToolUse(msg, messages, lectic)
    },

    provider : LLMProvider.Ollama,

}
