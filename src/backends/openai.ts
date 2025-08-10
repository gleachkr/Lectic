import OpenAI from 'openai'
import type { Message } from "../types/message"
import type { Lectic } from "../types/lectic"
import { LLMProvider } from "../types/provider"
import type { Backend } from "../types/backend"
import { MessageAttachment, MessageAttachmentPart } from "../types/attachment"
import { MessageCommand } from "../types/directive.ts"
import { Logger } from "../logging/logger"
import type { JSONSchema } from "../types/schema"
import { serializeCall, ToolCallResults,  type ToolCallResult } from "../types/tool"
import { systemPrompt, pdfFragment } from './common.ts'


function getTools(lectic : Lectic) : OpenAI.Chat.Completions.ChatCompletionTool[] {
    const tools : OpenAI.Chat.Completions.ChatCompletionTool[] = []
    for (const tool of Object.values(lectic.header.interlocutor.registry ?? {})) {

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
                    // OPENAI API always wants every key to be required?
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
    const registry = lectic.header.interlocutor.registry ?? {}
    const max_tool_use = lectic.header.interlocutor.max_tool_use ?? 10

    while (message.tool_calls) {
        yield "\n\n"
        recur++

        if (recur > max_tool_use + 2) {
            yield "<error>Runaway tool use!</error>"
        }

        messages.push({
            name: lectic.header.interlocutor.name,
            role: "assistant",
            tool_calls: message.tool_calls,
            content: message.content
        })

        const tool_calls : Promise<OpenAI.ChatCompletionToolMessageParam & 
            { content: ToolCallResult[] }>[] = message.tool_calls
            .map(async call => {
                const tool_call_id = call.id
                const role = "tool" as const
                if (recur > max_tool_use) {
                    return {
                        role, tool_call_id,
                        content: ToolCallResults(
                            "<error>Tool usage limit exceeded, no further tool calls will be allowed</error>")
                    }
                } else if (call.function.name in registry) {
                    return registry[call.function.name].call(JSON.parse(call.function.arguments))
                        .then(content => ({
                            role, tool_call_id, content
                            
                        })).catch((error : unknown) => ({
                            role, tool_call_id,
                            content: error instanceof Error
                                ? ToolCallResults(`<error>An error occurred: ${error.message}</error>`)
                                : ToolCallResults(`<error>An error of unknown type occured during a call to: ${call.function.name}</error>`)
                        }))
                } else {
                    return { role, tool_call_id,
                        content: ToolCallResults(`<error>Unrecognized tool name ${call.function.name}</error>`)
                    }
                }
            })

        // run tool calls in parallel
        const tool_call_results = await Promise.all(tool_calls)

        for (const call of message.tool_calls) {
            const result = tool_call_results.find(result => result.tool_call_id === call.id)
            if (result) {
                const theTool = call.function.name in registry 
                    ? registry[call.function.name] 
                    : null
                yield serializeCall(theTool, {
                    name: call.function.name,
                    args: JSON.parse(call.function.arguments), 
                    id: call.id,
                    results: result.content
                })
                yield "\n\n"
                messages.push(result)
            }
        }

        Logger.debug("openai - messages (tool)", messages)

        const stream = client.chat.completions.stream({
            messages: [developerMessage(lectic), ...messages],
            model: lectic.header.interlocutor.model ?? "Missing default model",
            temperature: lectic.header.interlocutor.temperature,
            max_completion_tokens: lectic.header.interlocutor.max_tokens || 1024,
            tools: getTools(lectic)
        })
    
        for await (const event of stream) {
            yield event.choices[0].delta.content || ""
        }

        message = await stream.finalMessage()

        Logger.debug("openai - reply (tool)", message)

    }
}

async function partToContent(part : MessageAttachmentPart) 
    : Promise<OpenAI.Chat.Completions.ChatCompletionContentPart | null> {
    const media_type = part.mimetype
    let bytes = part.bytes
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
        case "application/pdf" : {
            if (part.fragmentParams) bytes = await pdfFragment(bytes, part.fragmentParams)
            return {
                type : "file", 
                file: {
                    filename : part.title,
                    file_data : Buffer.from(bytes).toString("base64"),
                }
            } as const
        }
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
                results.push({role : "tool", tool_call_id : call.id ?? "undefined", content: call.results})
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
        const result = await command.execute()
        if (result) {
            content.push({
                type: "text",
                text: result,
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

        lectic.header.interlocutor.model = lectic.header.interlocutor.model ?? this.defaultModel

        let stream = this.client.chat.completions.stream({
            messages: [developerMessage(lectic), ...messages],
            model: lectic.header.interlocutor.model,
            temperature: lectic.header.interlocutor.temperature,
            max_completion_tokens: lectic.header.interlocutor.max_tokens || 1024,
            stream: true,
            tools: getTools(lectic)
        });


        for await (const event of stream) {
            yield event.choices[0].delta.content || ""
        }

        let msg = await stream.finalMessage()

        Logger.debug(`${this.provider} - reply`, msg)

        if (msg.tool_calls) {
            yield* handleToolUse(msg, messages, lectic, this.client);
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
