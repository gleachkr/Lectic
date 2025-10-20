import OpenAI from 'openai'
import type { Message } from "../types/message"
import type { Lectic } from "../types/lectic"
import { LLMProvider } from "../types/provider"
import type { Backend } from "../types/backend"
import { MessageAttachment, MessageAttachmentPart } from "../types/attachment"
import { MessageCommand } from "../types/directive.ts"
import { Logger } from "../logging/logger"
import { serializeCall } from "../types/tool"
import { systemPrompt, wrapText, pdfFragment, emitAssistantMessageEvent, resolveToolCalls } from './common.ts'

function getTools(lectic : Lectic) : OpenAI.Responses.Tool[] {
    const tools : OpenAI.Responses.Tool[] = []
    const nativeTools = (lectic.header.interlocutor.tools || [])
        .filter(tool => "native" in tool)
        .map(tool => tool.native)
    for (const tool of Object.values(lectic.header.interlocutor.registry ?? {})) {

        // the OPENAI API rejects default values for parameters. These are
        // hints about what happens when a value is missing, but they can
        // probably be safely scrubbed
        //
        // c.f. https://json-schema.org/understanding-json-schema/reference/annotations
        for (const key in tool.parameters) {
            if ("default" in tool.parameters[key]) {
                delete tool.parameters[key].default
            }
        }
        tools.push({
            type: "function",
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
        })
    }

    if (nativeTools.find(tool => tool === "search")) {
        tools.push({ type: "web_search_preview" })
    }

    if (nativeTools.find(tool => tool === "code")) {
        tools.push({ 
            type: "code_interpreter" ,
            container: { type: "auto" }
        })
    }
    return tools
}

async function *handleToolUse(
    message : OpenAI.Responses.Response, 
    messages : OpenAI.Responses.ResponseInput, 
    lectic : Lectic,
    client : OpenAI) : AsyncGenerator<string | Message> {

    let recur = 0
    const registry = lectic.header.interlocutor.registry ?? {}
    const max_tool_use = lectic.header.interlocutor.max_tool_use ?? 10

    while (message.output.filter(output => output.type == "function_call").length > 0) {
        yield "\n\n"
        recur++

        if (recur > max_tool_use + 2) {
            yield "<error>Runaway tool use!</error>"
            return
        }

        // Clean streaming leftovers that break the API
        for (const output of message.output) {
            if (output.type === "function_call" && 'parsed_arguments' in output) {
                delete output.parsed_arguments
            }
        }

        // Resolve calls to ToolCall[]
        const entries = message.output
            .filter(o => o.type === 'function_call')
            .map(o => {
                let args: unknown
                try { args = JSON.parse(o.arguments) } catch { args = undefined }
                return { id: o.call_id, name: o.name, args }
            })
        const realized = await resolveToolCalls(entries, registry, { limitExceeded: recur > max_tool_use })

        // Emit transcript and build provider outputs
        for (const o of message.output) {
            messages.push(o)
            if (o.type === 'function_call') {
                const call = realized.find(c => c.id === o.call_id && c.name === o.name)
                if (call) {
                    const theTool = o.name in registry ? registry[o.name] : null
                    yield serializeCall(theTool, {
                        name: o.name,
                        args: call.args,
                        id: o.call_id,
                        isError: call.isError,
                        results: call.results
                    })
                    yield "\n\n"
                    messages.push({
                        type: 'function_call_output',
                        call_id: o.call_id,
                        output: JSON.stringify(call.results)
                    })
                }
            }
        }

        Logger.debug("openai - messages (tool)", messages)

        const stream = client.responses.stream({
            instructions: systemPrompt(lectic),
            input: messages,
            model: lectic.header.interlocutor.model,
            include: [
                'reasoning.encrypted_content',
                'code_interpreter_call.outputs'
            ],
            temperature: lectic.header.interlocutor.temperature,
            max_output_tokens: lectic.header.interlocutor.max_tokens,
            tools: getTools(lectic)
        })
    
        let assistant = ""
        for await (const event of stream) {
            if (event.type == "response.output_text.delta") {
                const text = event.delta || ""
                yield text
                assistant += text
            }
        }

        message = await stream.finalResponse()

        Logger.debug("openai - reply (tool)", message)
        emitAssistantMessageEvent(assistant, lectic.header.interlocutor.name)

    }
}

async function partToContent(part : MessageAttachmentPart) 
    : Promise<OpenAI.Responses.ResponseInputContent | null> {
    const media_type = part.mimetype
    let bytes = part.bytes
    if (!(media_type && bytes)) return null
    switch(media_type) {
        case "image/gif" : 
        case "image/jpeg": 
        case "image/webp": 
        case "image/png": return {
            type : "input_image",
            image_url :  `data:${media_type};base64,${Buffer.from(bytes).toString("base64")}`,
            detail: "auto"
        } as const
        case "audio/mp3":
        case "audio/mpeg":
        case "application/pdf" : {
            if (part.fragmentParams) bytes = await pdfFragment(bytes, part.fragmentParams)
            return {
                type : "input_file", 
                filename : part.title,
                file_data : `data:${media_type};base64,${Buffer.from(bytes).toString("base64")}`,
            } as const
        }
        case "text/plain" : return {
            type : "input_text", 
            text: `<file title="${part.title}">${Buffer.from(bytes).toString()}</file>`
        } as const
        default: return {
            type : "input_text", 
            text: `<error>Media type ${media_type} is not supported.</error>` 
        }
    }
}

async function handleMessage(msg : Message, lectic : Lectic) : Promise<OpenAI.Responses.ResponseInput> {
    if (msg.role === "assistant" && msg.name === lectic.header.interlocutor.name) { 
        const results : OpenAI.Responses.ResponseInput = []
        for (const interaction of msg.containedInteractions()) {
            if (interaction.text) {
                results.push({
                    role: "assistant",
                    content: interaction.text
                })
            } 
            for (const call of interaction.calls) {
                const call_id = call.id ?? Bun.randomUUIDv7()
                results.push({
                    type: "function_call",
                    call_id,
                    name: call.name,
                    arguments: JSON.stringify(call.args)
                })
                results.push({
                    type: "function_call_output",
                    call_id,
                    output: JSON.stringify(call.results)
                })
            }
        }
        return results
    } else if (msg.role === "assistant") {
        return [{
            role: "user",
            content: [{
                type: "input_text",
                text: wrapText({
                    text: msg.content || "…",
                    name: msg.name
                })
            }]
        }]
    }

    const links = msg.containedLinks().flatMap(MessageAttachment.fromGlob)
    const parts : MessageAttachmentPart[] = []
    for await (const link of links) {
        if (await link.exists()) {
            parts.push(... await link.getParts())
        }
    }
    const commands = msg.containedDirectives().map(d => new MessageCommand(d))

    const content : OpenAI.Responses.ResponseInputMessageContentList = [{
        type: "input_text",
        text: msg.content
    }]

    for (const part of parts) {
        try {
            const source = await partToContent(part)
            if (source) content.push(source)
        } catch (e) {
            content.push({
                type: "input_text",
                text: `<error>Something went wrong while retrieving ${part.title} from ${part.URI}:${(e as Error).message}</error>`
            })
        }
    }

    for (const command of commands) {
        const result = await command.execute()
        if (result) {
            content.push({
                type: "input_text",
                text: result,
            })
        }
    }

    return [{ role : msg.role, content }]
}

export class OpenAIResponsesBackend implements Backend {

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

    async listModels(): Promise<string[]> {
        try {
            const ids: string[] = []
            const page = await this.client.models.list()
            for await (const m of page) ids.push(m.id)
            return ids
        } catch (_e) {
            return []
        }
    }

    async *evaluate(lectic : Lectic) : AsyncIterable<string | Message> {

        const messages : OpenAI.Responses.ResponseInput = []

        for (const msg of lectic.body.messages) {
            messages.push(...await handleMessage(msg, lectic))
        }

        Logger.debug("openai - messages", messages)

        lectic.header.interlocutor.model = lectic.header.interlocutor.model ?? "gpt-5"

        let stream = this.client.responses.stream({
            instructions: systemPrompt(lectic),
            input: messages,
            model: lectic.header.interlocutor.model,
            include: [
                'reasoning.encrypted_content',
                'code_interpreter_call.outputs'
            ],
            temperature: lectic.header.interlocutor.temperature,
            max_output_tokens: lectic.header.interlocutor.max_tokens,
            tools: getTools(lectic)
        });


        let assistant = ""
        for await (const event of stream) {
            if (event.type == "response.output_text.delta") {
                const text = event.delta || ""
                yield text
                assistant += text
            }
        }

        let msg = await stream.finalResponse()

        Logger.debug(`${this.provider} - reply`, msg)
        emitAssistantMessageEvent(assistant, lectic.header.interlocutor.name)

        if (msg.output.some(output => output.type === "function_call")) {
            yield* handleToolUse(msg, messages, lectic, this.client);
        } else {
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
