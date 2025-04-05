import Anthropic from '@anthropic-ai/sdk';
import type { Message } from "../types/message"
import { AssistantMessage } from "../types/message"
import type { Lectic } from "../types/lectic"
import { serializeCall, Tool } from "../types/tool"
import { LLMProvider } from "../types/provider"
import type { Backend } from "../types/backend"
import { MessageAttachment } from "../types/attachment.ts"
import { MessageCommand } from "../types/directive.ts"
import { Logger } from "../logging/logger"
import { systemPrompt, wrapText } from "./util"

function getText(msg : Anthropic.Messages.Message) : string {
    let rslt =""
    for (const block of msg.content) {
        if (block.type == "text") {
            rslt += block.text
        }
    }
    if (rslt === "") rslt = "…"
    return rslt
}

async function linkToContent(link : MessageAttachment) {
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

async function handleMessage(msg : Message, lectic: Lectic) : Promise<Anthropic.Messages.MessageParam[]> {
    if (msg.role === "assistant" && msg.name === lectic.header.interlocutor.name) { 
        const results : Anthropic.Messages.MessageParam[] = []
        for (const interaction of msg.containedInteractions()) {
            const modelParts : Anthropic.Messages.ContentBlockParam[] = []
            const userParts : Anthropic.Messages.ContentBlockParam[] = []
            if (interaction.text.length > 0) {
                modelParts.push({
                    type: "text" as "text",
                    text: interaction.text
                })
            }
            for (const call of interaction.calls) {
                modelParts.push({
                    type: "tool_use",
                    name: call.name,
                    id: call.id ?? "undefined",
                    input: call.args
                })
            }

            results.push({ role: "assistant", content: modelParts})


            if (interaction.calls.length > 0) {
                for (const call of interaction.calls) {
                    userParts.push({
                        type : "tool_result",
                        tool_use_id : call.id ?? "undefined",
                        content: call.result,
                        is_error: call.isError,
                    })
                }
                results.push({role : "user", content: userParts})
            }
        }
        return results
    } else if (msg.role === "assistant") {
        return [{ 
            role : "user", 
            content: [{ 
                type: "text", 
                text: wrapText({
                    text: msg.content || "…", 
                    name: msg.name
                })}]
        }]
    } else {

        const links = msg.containedLinks().flatMap(MessageAttachment.fromGlob)
        const commands = msg.containedDirectives().map(d => new MessageCommand(d))

        const content : Anthropic.Messages.ContentBlockParam[] = [{
            type: "text" as "text",
            text: msg.content || "…"
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

        for (const command of commands) {
            await command.execute()
            if (command.success) {
                content.push({
                    type: "text",
                    text: `<stdout from="${command.command}">${command.stdout}</stdout>`
                })
            } else {
                content.push({
                    type: "text",
                    text: `<error>Something went wrong when executing a command:` + 
                        `<stdout from="${command.command}">${command.stdout}</stdout>` +
                        `<stderr from="${command.command}">${command.stderr}</stderr>` +
                        `</error>`
                })
            }
        }

        return [{ role : msg.role, content }]
    }
}


function getTools() : Anthropic.Messages.Tool[] {
    const tools : Anthropic.Messages.Tool[] = []
    for (const tool of Object.values(Tool.registry)) {
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

async function* handleToolUse(
    message: Anthropic.Messages.Message, 
    messages : Anthropic.Messages.MessageParam[], 
    lectic : Lectic,
    client : Anthropic
    ) : AsyncGenerator<string | Message> {

        let recur = 0

        while (message.stop_reason == "tool_use") {
            yield "\n\n"
            recur++

            if (recur > 12) {
                yield "<error>Runaway tool use!</error>"
                yield new AssistantMessage({
                    content: "<error>Runaway tool use!</error>",
                    name: lectic.header.interlocutor.name
                })
                return
            }

            messages.push({
                role: "assistant",
                content: message.content
            })

            const content: Anthropic.Messages.ToolResultBlockParam[] = []

            for (const block of message.content) {
                if (block.type == "tool_use") {
                    let result : string
                    let is_error = false
                    if (recur > 10) {
                        result = "Tool usage limit exceeded, no further tool calls will be allowed"
                        is_error = true
                    } else {
                        if (!(block.input instanceof Object)) {
                            result = "The tool input isn't the right type. Tool inputs need to be returned as objects."  
                            is_error = true
                        } else if (block.name in Tool.registry) {
                            try {
                                result = await Tool.registry[block.name].call(block.input)
                            } catch (e : unknown) {
                                if (e instanceof Error) {
                                    result = e.message
                                    is_error = true
                                } else {
                                    throw e
                                }
                            }
                            yield serializeCall(Tool.registry[block.name], {
                                name: block.name,
                                args: block.input, 
                                id: block.id,
                                isError : is_error,
                                result
                            })

                            yield "\n\n"
                        } else {
                            result = `Unrecognized tool name ${block.name}`
                            is_error = true
                        }
                        content.push({
                            type : "tool_result",
                            tool_use_id : block.id,
                            content: result,
                            is_error: is_error,
                        })
                    }
                }
            }

            messages.push({ role: "user", content })

            Logger.debug("anthropic - messages (tool)", messages)

            let stream = (client as Anthropic).messages.stream({
                max_tokens: lectic.header.interlocutor.max_tokens || 1024,
                system: systemPrompt(lectic),
                messages: messages,
                model: lectic.header.interlocutor.model ?? 
                    'claude-3-7-sonnet-latest',
                tools: getTools()
            });

            for await (const messageEvent of stream) {
                if (messageEvent.type === 'content_block_delta') {
                    yield messageEvent.delta.text
                }
            }

            message = await stream.finalMessage()

            Logger.debug("anthropic - reply (tool)", message)

            yield new AssistantMessage({
                content: getText(message),
                name: lectic.header.interlocutor.name
            })

        }

    }

    export const AnthropicBackend : Backend & { client : Anthropic } = {

        async *evaluate(lectic : Lectic) : AsyncIterable<string | Message> {

            const messages : Anthropic.Messages.MessageParam[] = []

            for (const msg of lectic.body.messages) {
                messages.push(...await handleMessage(msg, lectic))
            }

            Logger.debug("anthropic - messages", messages)

            let stream = this.client.messages.stream({
                system: systemPrompt(lectic),
                messages: messages,
                model: lectic.header.interlocutor.model ?? 'claude-3-7-sonnet-latest',
                temperature: lectic.header.interlocutor.temperature,
                max_tokens: lectic.header.interlocutor.max_tokens || 1024,
                tools: getTools()
            });

            for await (const messageEvent of stream) {
                if (messageEvent.type === 'content_block_delta') {
                    yield messageEvent.delta.text
                }
            }

            let msg = await stream.finalMessage()

            Logger.debug("anthropic - reply", msg)

            if (msg.stop_reason == "tool_use") {
                yield* handleToolUse(msg, messages, lectic, this.client)
            } else {
                yield new AssistantMessage({
                    content: getText(msg),
                    name: lectic.header.interlocutor.name
                })
            }
        },

        client : new Anthropic({
            apiKey: process.env['ANTHROPIC_API_KEY'], // TODO api key on cli or in lectic
        }),

        provider : LLMProvider.Anthropic,

    }
