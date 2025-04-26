import OpenAI from 'openai'
import type { Message } from "../types/message"
import { AssistantMessage } from "../types/message"
import type { Lectic } from "../types/lectic"
import { LLMProvider } from "../types/provider"
import type { Backend } from "../types/backend"
import { MessageAttachment, MessageAttachmentPart } from "../types/attachment"
import { MessageCommand } from "../types/directive.ts"
import { Logger } from "../logging/logger"
import type { JSONSchema } from "../types/schema"
import { serializeCall, Tool } from "../types/tool"
import { systemPrompt } from './util'

function getText(msg : OpenAI.Chat.ChatCompletionMessage) : string {
    return msg.content ?? "…"
}

function getTools() : OpenAI.Chat.Completions.ChatCompletionTool[] {
    const tools : OpenAI.Chat.Completions.ChatCompletionTool[] = []
    for (const tool of Object.values(Tool.registry)) {

        // the OPENAI API rejects default values for parameters. These are
        // hints about what happens when a value is missing, but they can
        // probably be safely scrubbed
        //
        // c.f. https://json-schema.org/understanding-json-schema/reference/annotations
        const cleanParameters : {[key: string] : JSONSchema } = {}
        for (const key in tool.parameters) {
            cleanParameters[key] = tool.parameters[key]
            if ("default" in cleanParameters[key]) {
                delete cleanParameters[key].default
            }
        }
        tools.push({
            type: "function",
            function: {
                name : tool.name,
                description : tool.description,
                strict: true,
                parameters: {
                    "type" : "object",
                    "properties" : tool.parameters,
                    // OPENAI API always wants every key to be required
                    "required" : Object.keys(tool.parameters),
                    "additionalProperties" : false,
                }
            }
        })
    }
    return tools
}

async function *handleToolUse(
    message : OpenAI.Chat.ChatCompletionMessage, 
    messages : OpenAI.Chat.Completions.ChatCompletionMessageParam[], 
    lectic : Lectic,
    client : OpenAI) : AsyncGenerator<string | Message> {

    let recur = 0
    while (message.tool_calls) {
        yield "\n\n"
        recur++

        if (recur > 12) {
            yield "<error>Runaway tool use!</error>"
            yield new AssistantMessage({
                name: lectic.header.interlocutor.name,
                content: "<error>Runaway tool use!</error>"
            })
        }

        messages.push({
            name: lectic.header.interlocutor.name,
            role: "assistant",
            tool_calls: message.tool_calls,
            content: message.content
        })

        for (const call of message.tool_calls) {
            let result : string
            if (recur > 10) {
                result = "<error>Tool usage limit exceeded, no further tool calls will be allowed</error>"
            } else if (call.function.name in Tool.registry) {
                 // TODO error handling
                const inputs = JSON.parse(call.function.arguments)
                try {
                    result = await Tool.registry[call.function.name].call(inputs)
                } catch (e) {
                    if (e instanceof Error) {
                        result = `<error>An Error Occurred: ${e.message}</error>`
                    } else {
                        throw e
                    }
                }
                yield serializeCall(Tool.registry[call.function.name], {
                    name: call.function.name,
                    args: inputs, 
                    result
                })
                yield "\n\n"
            } else {
                result = `<error>Unrecognized tool name ${call.function.name}</error>`
            }
            messages.push({
                    role: "tool",
                    tool_call_id : call.id,
                    content: result
            })
        }

        Logger.debug("openai - messages (tool)", messages)

        const stream = client.beta.chat.completions.stream({
            messages: messages.concat([developerMessage(lectic)]),
            model: lectic.header.interlocutor.model ?? 'gpt-4.1',
            temperature: lectic.header.interlocutor.temperature,
            max_tokens: lectic.header.interlocutor.max_tokens || 1024,
            tools: getTools()
        })
    
        for await (const event of stream) {
            yield event.choices[0].delta.content || ""
        }

        message = await stream.finalMessage()

        Logger.debug("openai - reply (tool)", message)

        yield new AssistantMessage({
            name: lectic.header.interlocutor.name,
            content: getText(message)
        })
    }
}

async function partToContent(part : MessageAttachmentPart) 
    : Promise<OpenAI.Chat.Completions.ChatCompletionContentPart | null> {
    const media_type = part.mimetype
    const bytes = part.bytes
    if (!(media_type && bytes)) return null
    switch(media_type) {
        case "image/gif" : 
        case "image/jpeg": 
        case "image/webp": 
        case "image/png": return {
            type : "image_url",
            image_url : {
                url : `data:${media_type};base64,${Buffer.from(bytes).toString("base64")}`
            }
        } as const
        case "audio/mp3":
        case "audio/mpeg":
        case "audio/wav": return {
            type: "input_audio",
            input_audio: {
                data: Buffer.from(bytes).toString("base64"),
                format: media_type === "audio/wav" ? "wav" : "mp3",
            }
        }
        case "application/pdf" : return {
            type : "file", 
            file: {
                filename : part.title,
                file_data : Buffer.from(bytes).toString("base64"),
            }
        } as const
        case "text/plain" : return {
            type : "text", 
            text: `<file title="${part.title}">${Buffer.from(bytes).toString()}</file>`
        } as const
        default: return {
            type : "text", 
            text: `<error>Media type ${media_type} is not supported.</error>` 
        }
    }
}

async function handleMessage(msg : Message) : Promise<OpenAI.Chat.Completions.ChatCompletionMessageParam[]> {
    if (msg.role === "assistant") { 
        const results : OpenAI.Chat.Completions.ChatCompletionMessageParam[] = []
        for (const interaction of msg.containedInteractions()) {
            const modelParts : OpenAI.Chat.Completions.ChatCompletionContentPartText[] = []
            const toolCalls : OpenAI.Chat.Completions.ChatCompletionMessageToolCall[] = []
            if (interaction.text.length > 0) {
                modelParts.push({
                    type: "text" as "text",
                    text: interaction.text
                })
            }
            for (const call of interaction.calls) {
                toolCalls.push({
                    type: "function",
                    id: call.id ?? "undefined",
                    function : {
                        name: call.name,
                        arguments: JSON.stringify(call.args)
                    }
                })
            }

            results.push({ 
                name: msg.name,
                role: "assistant", 
                content: modelParts, 
                tool_calls: toolCalls.length > 0 ? toolCalls : undefined
            })

            for (const call of interaction.calls) {
                results.push({role : "tool", tool_call_id : call.id ?? "undefined", content: call.result})
            }
        }
        return results
    }

    const links = msg.containedLinks().flatMap(MessageAttachment.fromGlob)
    const parts : MessageAttachmentPart[] = []
    for await (const link of links) {
        if (await link.exists()) {
            parts.push(... await link.getParts())
        }
    }
    const commands = msg.containedDirectives().map(d => new MessageCommand(d))

    const content : OpenAI.Chat.Completions.ChatCompletionContentPart[] = [{
        type: "text" as "text",
        text: msg.content
    }]

    for (const part of parts) {
        try {
            const source = await partToContent(part)
            if (source) content.push(source)
        } catch (e) {
            content.push({
                type: "text",
                text: `<error>Something went wrong while retrieving ${part.title} from ${part.URI}:${(e as Error).message}</error>`
            })
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

function developerMessage(lectic : Lectic) {
    return {
        role : "developer" as "developer",
        content: systemPrompt(lectic)
    }
}

export class OpenAIBackend implements Backend {

    provider: LLMProvider
    defaultModel: string
    apiKey: string
    url?: string

    constructor(opt: {apiKey: string, provider : LLMProvider, url?: string, defaultModel: string}) {
        this.provider = opt.provider
        this.apiKey = opt.apiKey
        this.defaultModel = opt.defaultModel
        this.url = opt.url
    }

    async *evaluate(lectic : Lectic) : AsyncIterable<string | Message> {

        const messages : OpenAI.Chat.Completions.ChatCompletionMessageParam[] = []

        for (const msg of lectic.body.messages) {
            messages.push(...await handleMessage(msg))
        }

        Logger.debug("openai - messages", messages)

        let stream = this.client.beta.chat.completions.stream({
            messages: messages.concat([developerMessage(lectic)]),
            model: lectic.header.interlocutor.model ?? this.defaultModel,
            temperature: lectic.header.interlocutor.temperature,
            max_tokens: lectic.header.interlocutor.max_tokens || 1024,
            stream: true,
            tools: getTools()
        });


        for await (const event of stream) {
            yield event.choices[0].delta.content || ""
        }

        let msg = await stream.finalMessage()

        Logger.debug(`${this.provider} - reply`, msg)

        if (msg.tool_calls) {
            yield* handleToolUse(msg, messages, lectic, this.client);
        } else {
            yield new AssistantMessage({
                name: lectic.header.interlocutor.name,
                content: getText(msg)
            })
        }
    }

    get client() { 
        return new OpenAI({
            apiKey: process.env[this.apiKey] || "", 
            baseURL: this.url,
            // quirk: OPENAI throws an error if the key is not in the environment. 
            // Need to think about this for providers more generally in case one of them changes their interface.
            // TODO api key on cli or in lectic
        })
    }

}
