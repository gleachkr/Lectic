import OpenAI from 'openai'
import { Message } from "../types/message"
import type { Lectic } from "../types/lectic"
import { LLMProvider } from "../types/provider"
import type { Backend } from "../types/backend"
import { MessageAttachment } from "../types/attachment"
import { MessageCommand } from "../types/directive.ts"
import { Logger } from "../logging/logger"
import { initRegistry, ToolRegistry } from "../types/tool_spec"
import { systemPrompt } from './util'

function getText(msg : OpenAI.Chat.ChatCompletionMessage) : string {
    return msg.content ?? "…"
}

function getTools() : OpenAI.Chat.Completions.ChatCompletionTool[] {
    const tools : OpenAI.Chat.Completions.ChatCompletionTool[] = []
    for (const tool of Object.values(ToolRegistry)) {
        tools.push({
            type: "function",
            function: {
                name : tool.name,
                description : tool.description,
                strict: true,
                parameters: {
                    "type" : "object",
                    "properties" : tool.parameters,
                    "required" : tool.required ?? [],
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
            yield new Message({
                role: "assistant", 
                content: "<error>Runaway tool use!</error>"
            })
        }

        messages.push({
            role: "assistant",
            tool_calls: message.tool_calls,
            content: message.content
        })

        for (const call of message.tool_calls) {
            if (recur > 10) {
                messages.push({
                    role: "tool",
                    tool_call_id : call.id,
                    content: "Tool usage limit exceeded, no further tool calls will be allowed",
                })
            } else if (call.function.name in ToolRegistry) {
                 // TODO error handling
                const inputs = JSON.parse(call.function.arguments)
                await ToolRegistry[call.function.name].call(inputs)
                    .then(rslt => messages.push({
                            role: "tool",
                            tool_call_id : call.id,
                            content : rslt,
                    })).catch((e : Error) => messages.push({
                            role: "tool",
                            tool_call_id : call.id,
                            content: `<error>An Error Occurred: ${e.message}</error>`,
                    }))
            }
        }

        Logger.debug("openai - messages (tool)", messages)

        const stream = client.beta.chat.completions.stream({
            messages: messages.concat([developerMessage(lectic)]),
            model: lectic.header.interlocutor.model ?? 'gpt-4o',
            temperature: lectic.header.interlocutor.temperature,
            max_tokens: lectic.header.interlocutor.max_tokens || 1024,
            tools: getTools()
        })
    
        for await (const event of stream) {
            yield event.choices[0].delta.content || ""
        }

        message = await stream.finalMessage()

        Logger.debug("openai - reply (tool)", message)

        yield new Message({
            role: "assistant", 
            content: getText(message)
        })
    }
}

async function linkToContent(link : MessageAttachment) 
    : Promise<OpenAI.Chat.Completions.ChatCompletionContentPart | null> {
    const media_type = await link.getType()
    const bytes = await link.getBytes()
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
        case "application/pdf" : return {
            type : "file", 
            file: {
                file_name : link.title,
                file_data : Buffer.from(bytes).toString("base64"),
            }
        } as const
        case "text/plain" : return {
            type : "text", 
            text: `<file title="${link.title}">${Buffer.from(bytes).toString()}</file>`
        } as const
        default: return {
            type : "text", 
            text: `<error>Media type ${media_type} is not supported.</error>` 
        }
    }
}

async function handleMessage(msg : Message) : Promise<OpenAI.Chat.Completions.ChatCompletionMessageParam> {
    if (msg.role != "user") { return msg }

    const links = msg.containedLinks().flatMap(MessageAttachment.fromGlob)
    const commands = msg.containedDirectives().map(d => new MessageCommand(d))

    const content : OpenAI.Chat.Completions.ChatCompletionContentPart[] = [{
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

    return { role : msg.role, content }
}

function developerMessage(lectic : Lectic) {
    return {
        role : "developer" as "developer",
        content: systemPrompt(lectic)
    }
}


export const OpenAIBackend : Backend & { client : OpenAI} = {

    async *evaluate(lectic : Lectic) : AsyncIterable<string | Message> {

        if (lectic.header.interlocutor.tools) {
            initRegistry(lectic.header.interlocutor.tools)
        }

        const messages : OpenAI.Chat.Completions.ChatCompletionMessageParam[] = []

        for (const msg of lectic.body.messages) {
            messages.push(await handleMessage(msg))
        }

        Logger.debug("openai - messages", messages)

        let stream = (this.client as OpenAI).beta.chat.completions.stream({
            messages: messages.concat([developerMessage(lectic)]),
            model: lectic.header.interlocutor.model ?? 'gpt-4o',
            temperature: lectic.header.interlocutor.temperature,
            max_tokens: lectic.header.interlocutor.max_tokens || 1024,
            stream: true,
            tools: getTools()
        });


        for await (const event of stream) {
            yield event.choices[0].delta.content || ""
        }

        let msg = await stream.finalMessage()

        Logger.debug("openai - reply", msg)

        if (msg.tool_calls) {
            yield* handleToolUse(msg, messages, lectic, this.client);
        } else {
            yield new Message({
                role: "assistant",
                content: getText(msg)
            })
        }
    },


    provider : LLMProvider.Anthropic,

    client : new OpenAI({
        apiKey: process.env['OPENAI_API_KEY'] || "", 
        // quirk: OPENAI throws an error if the key is not in the environment. 
        // Need to think about this for providers more generally in case one of them changes their interface.
        // TODO api key on cli or in lectic
    }),

}
