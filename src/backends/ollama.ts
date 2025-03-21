import ollama from 'ollama'
import * as Ollama from 'ollama'
import { Message } from "../types/message"
import type { Lectic } from "../types/lectic"
import { LLMProvider } from "../types/provider"
import type { Backend } from "../types/backend"
import { MessageCommand } from "../types/directive.ts"
import { MessageAttachment } from "../types/attachment"
import { Logger } from "../logging/logger"
import { initRegistry, ToolRegistry } from "../types/tool_spec"
import { systemPrompt } from './util'

function getText(response : Ollama.ChatResponse) : string {
    return response.message.content ?? "…"
}

// this implementation is pretty conjectural. It would be good to consult some other implementations
function messageReducer(
    previous: Ollama.ChatResponse,
    item: Ollama.ChatResponse
  ): Ollama.ChatResponse {

  const reduce = (acc: any, delta: any) => {
    acc = { ...acc };
    for (const [key, value] of Object.entries(delta)) {
      if (typeof acc[key] === 'string' && typeof value === 'string') {
        if (key == "content") (acc[key] as string) += value;
        else acc[key] = value;
      } else if (typeof acc[key] === 'object' && !Array.isArray(acc[key])) {
        acc[key] = reduce(acc[key], value);
      } else {
        acc[key] = value;
      }
    }
    return acc;
  };

  return reduce(previous, item) as Ollama.ChatResponse;
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

async function* handleToolUse(
    response : Ollama.ChatResponse, 
    messages : Ollama.Message[], 
    lectic : Lectic,
    ) : AsyncGenerator<string | Message> {

    let recur = 0

    while (response.message.tool_calls) {
        yield "\n\n"
        recur++
        
        if (recur > 12) {
            yield "<error>Runaway tool use!</error>"
            yield new Message({
                role: "assistant", 
                content: "<error>Runaway tool use!</error>"
            })
            return
        }

        messages.push({
            role: "assistant",
            content: response.message.content,
            tool_calls: response.message.tool_calls
        })

        for (const call of response.message.tool_calls) {
            if (recur > 10) {
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

        Logger.debug("ollama - messages", messages)

        const stream = await ollama.chat({
            messages: [developerMessage(lectic), ...messages],
            model: lectic.header.interlocutor.model ?? 'llama-3.2',
            stream: true,
            tools: getTools(),
            options: {
                temperature: lectic.header.interlocutor.temperature,
            }
        });


        response = {} as Ollama.ChatResponse

        for await (const event of stream) {
            yield event.message.content
            response = messageReducer(response, event)
        }

        Logger.debug("ollama - reply (tool)", response)
    }

    return new Message({
        role: "assistant", 
        content: getText(response)
    })
}

async function linkToContent(link : MessageAttachment) 
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
        case "text/plain" : return {
            text: `<file title="${link.title}">${Buffer.from(bytes).toString()}</file>`
        } as const
        default: return {
            text: `<error>Media type ${media_type} is not supported.</error>` 
        }
    }
}

async function handleMessage(msg : Message) : Promise<Ollama.Message> {
    if (msg.role != "user") { return msg }

    const links = msg.containedLinks().flatMap(MessageAttachment.fromGlob)
    const commands = msg.containedDirectives().map(d => new MessageCommand(d))

    const images : string[] = []

    for (const link of links) {
        const exists = await link.exists()
        if (exists) {
            try {
                const source = await linkToContent(link)
                if (source && source.image_data) images.push(source.image_data)
                if (source && source.text) msg.content += source.text
            } catch (e) {
                msg.content += 
                    `<error>Something went wrong while retrieving ${link.title} from ${link.URI}:${(e as Error).message}</error>`
            }
        }
    }

    for (const command of commands) {
        await command.execute()
        if (command.success) {
            msg.content += `<stdout from="${command.command}">${command.stdout}</stdout>`
        } else {
            msg.content += `<error>Something went wrong when executing a command:` + 
                `<stdout from="${command.command}">${command.stdout}</stdout>` +
                `<stderr from="${command.command}">${command.stderr}</stderr>` +
            `</error>`
        }
    }

    return { role : msg.role, content : msg.content, images : images}
}

function developerMessage(lectic : Lectic): Ollama.Message {
    return {
        role : "system" as "system",
        content: systemPrompt(lectic)
    }
}

export const OllamaBackend : Backend = {

    async *evaluate(lectic : Lectic) : AsyncIterable<string | Message> {

        if (lectic.header.interlocutor.tools) {
            initRegistry(lectic.header.interlocutor.tools)
        }

        const messages : Ollama.Message[] = []

        for (const msg of lectic.body.messages) {
            messages.push(await handleMessage(msg))
        }

        Logger.debug("ollama - messages", messages)

        let stream = await ollama.chat({
            messages: [developerMessage(lectic), ...messages],
            model: lectic.header.interlocutor.model || 'llama3.2',
            tools: getTools(),
            stream: true,
            options: {
                temperature: lectic.header.interlocutor.temperature,
            }
        });

        let msg = {} as Ollama.ChatResponse

        for await (const event of stream) {
            yield event.message.content
            msg = messageReducer(msg, event)
        }

        Logger.debug("ollama - reply", msg)

        if (msg.message.tool_calls) {
            yield* handleToolUse(msg, messages, lectic)
        } else {
            yield new Message({
                role: "assistant",
                content: getText(msg)
            })
        }
    },

    provider : LLMProvider.Ollama,

}
