import Anthropic from '@anthropic-ai/sdk';
import { AnthropicBedrock } from '@anthropic-ai/bedrock-sdk';
import type { Message } from "../types/message"
import type { Lectic } from "../types/lectic"
import { serializeCall } from "../types/tool"
import { LLMProvider } from "../types/provider"
import type { Backend } from "../types/backend"
import { MessageAttachment, MessageAttachmentPart } from "../types/attachment"
import { MessageCommand } from "../types/directive.ts"
import { Logger } from "../logging/logger"
import { systemPrompt, wrapText, pdfFragment, emitAssistantMessageEvent, resolveToolCalls } from "./common.ts"

// Yield only text deltas from an Anthropic stream, plus blank lines when
// server tool use blocks begin (to preserve formatting semantics).
export async function* anthropicTextChunks(
    stream: any
) : AsyncGenerator<string> {
    for await (const messageEvent of stream) {
        if (messageEvent.type === 'content_block_delta' && 
            messageEvent.delta.type === "text_delta") {
            yield messageEvent.delta.text
        }
        if (messageEvent.type === 'content_block_start' &&
            (messageEvent as any).content_block?.type === 'server_tool_use') {
            yield '\n\n'
        }
    }
}

async function partToContent(part: MessageAttachmentPart) {
    const media_type = part.mimetype
    let bytes = part.bytes
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
            case "application/pdf" : 
                if (part.fragmentParams) bytes = await pdfFragment(bytes, part.fragmentParams)
                return {
                    type : "document", 
                    title : part.title,
                    source : {
                        "type" : "base64",
                        "media_type" : "application/pdf",
                        "data" : Buffer.from(bytes).toString("base64")
                    }
                } as const
            case "text/plain" : return {
                type : "document", 
                title : part.title,
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

function updateCache(messages : Anthropic.Messages.MessageParam[]) {
    let idx = 0
    for (const message of messages) {
        if (message.content.length > 0) {
            const last_content = message.content[message.content.length - 1]
            if (typeof last_content !== "string" && 
                last_content.type !== "redacted_thinking" &&
                    last_content.type !== "thinking") 
                {
                    if (idx == messages.length - 1) { 
                        last_content.cache_control = { type: "ephemeral" }
                    } else if (typeof last_content !== "string") {
                        delete last_content.cache_control
                    }
                }
        }
        idx++
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

            if (interaction.calls.length > 0) {

                for (const call of interaction.calls) {
                    const call_id = call.id ?? Bun.randomUUIDv7()
                    modelParts.push({
                        type: "tool_use",
                        name: call.name,
                        id: call_id,
                        input: call.args
                    })

                    userParts.push({
                        type : "tool_result",
                        tool_use_id : call_id,
                        content: call.results.map(r => ({ type: "text" as const, text: r.toBlock().text })),
                        is_error: call.isError,
                    })
                }
            }

            results.push({ role: "assistant", content: modelParts })
            if (userParts.length > 0) {
                results.push({ role : "user", content: userParts })
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
        const parts : MessageAttachmentPart[] = []
        for await (const link of links) {
            if (await link.exists()) {
                parts.push(... await link.getParts())
            }
        }
        const commands = msg.containedDirectives().map(d => new MessageCommand(d))

        const content : Anthropic.Messages.ContentBlockParam[] = [{
            type: "text" as "text",
            text: msg.content || "…"
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
}

function getTools(lectic : Lectic) : Anthropic.Messages.ToolUnion[] {

    const nativeTools = (lectic.header.interlocutor.tools || [])
    .filter(tool => "native" in tool)
    .map(tool => tool.native)

    const tools : Anthropic.Messages.ToolUnion[]  = []
    for (const tool of Object.values(lectic.header.interlocutor.registry ?? {})) {
        tools.push({
            name : tool.name,
            description : tool.description,
            input_schema : {
                type : "object",
                properties : tool.parameters,
                required : tool.required
            }
        })
    }

    if (nativeTools.find(tool => tool === "search")) {
        tools.push({
            name: "web_search",
            type: "web_search_20250305"
        })
    }
    return tools
}

async function* handleToolUse(
    message: Anthropic.Messages.Message, 
    messages : Anthropic.Messages.MessageParam[], 
    lectic : Lectic,
    client : Anthropic | AnthropicBedrock,
    model : string,
) : AsyncGenerator<string | Message> {

    let recur = 0
    const registry = lectic.header.interlocutor.registry ?? {}
    const max_tool_use = lectic.header.interlocutor.max_tool_use ?? 10

    while (message.stop_reason == "tool_use") {
        yield "\n\n"
        recur++

        if (recur > max_tool_use + 2) {
            yield "<error>Runaway tool use!</error>"
            return
        }

        messages.push({
            role: "assistant",
            content: message.content
        })

        const tool_uses = message.content.filter(block => block.type == "tool_use")
        const entries = tool_uses.map(block => ({ id: block.id, name: block.name, args: block.input }))
        const realized = await resolveToolCalls(entries, registry, { limitExceeded: recur > max_tool_use })

        // convert to anthropic blocks for the API
        const content: Anthropic.Messages.ToolResultBlockParam[] = realized.map(call => ({
            type: "tool_result" as const,
            tool_use_id: call.id ?? "",
            is_error: call.isError,
            content: call.results.map(r => ({ type: "text" as const, text: r.toBlock().text }))
        }))

        // yield results to the transcript, preserving mimetypes
        for (const block of tool_uses) {
            const call = realized.find(c => c.id === block.id)
            if (call && block.input instanceof Object) {
                const theTool = block.name in registry ? registry[block.name] : null
                yield serializeCall(theTool, {
                    name: block.name,
                    args: block.input,
                    id: block.id,
                    isError: call.isError,
                    results: call.results
                }) + "\n\n"
            }
        }

        messages.push({ role: "user", content })

        if (!lectic.header.interlocutor.nocache) updateCache(messages)

        Logger.debug("anthropic - messages (tool)", messages)

        let stream = client.messages.stream({
            max_tokens: lectic.header.interlocutor.max_tokens || 2048,
            system: systemPrompt(lectic),
            messages: messages,
            model,
            tools: getTools(lectic)
        });

        let assistant = ""
        for await (const text of anthropicTextChunks(stream)) {
            yield text
            assistant += text
        }

        message = await stream.finalMessage()

        Logger.debug("anthropic - reply (tool)", message)
        emitAssistantMessageEvent(assistant, lectic.header.interlocutor.name)

    }

}

export const AnthropicBackend : Backend & { client : Anthropic } = {

    async listModels(): Promise<string[]> {
        try {
            const page = await this.client.models.list()
            const ids: string[] = []
            for await (const m of page) ids.push(m.id)
            return ids
        } catch (_e) {
            return []
        }
    },

    async *evaluate(lectic : Lectic) : AsyncIterable<string | Message> {

        const messages : Anthropic.Messages.MessageParam[] = []

        for (const msg of lectic.body.messages) {
            messages.push(...await handleMessage(msg, lectic))
        }

        if (!lectic.header.interlocutor.nocache) updateCache(messages)

        Logger.debug("anthropic - messages", messages)

        const model = lectic.header.interlocutor.model ?? 'claude-sonnet-4-20250514'

        let stream = this.client.messages.stream({
            system: systemPrompt(lectic),
            messages: messages,
            model,
            temperature: lectic.header.interlocutor.temperature,
            max_tokens: lectic.header.interlocutor.max_tokens || 2048,
            tools: getTools(lectic)
        });

        let assistant = ""
        for await (const text of anthropicTextChunks(stream)) {
            yield text
            assistant += text
        }

        let msg = await stream.finalMessage()

        Logger.debug("anthropic - reply", msg)
        emitAssistantMessageEvent(assistant, lectic.header.interlocutor.name)

        if (msg.stop_reason == "tool_use") {
            yield* handleToolUse(msg, messages, lectic, this.client, model)
        } 
    },

    client : new Anthropic({
        apiKey: process.env['ANTHROPIC_API_KEY'], // TODO api key on cli or in lectic
        maxRetries: 5,
    }),

    provider : LLMProvider.Anthropic,

}

export const AnthropicBedrockBackend : Backend & { client : AnthropicBedrock } = {

    async listModels(): Promise<string[]> {
        // Bedrock model enumeration via Anthropic SDK is not supported
        // here. Return an empty list for now.
        return []
    },

    async *evaluate(lectic : Lectic) : AsyncIterable<string | Message> {

        const messages : Anthropic.Messages.MessageParam[] = []

        for (const msg of lectic.body.messages) {
            messages.push(...await handleMessage(msg, lectic))
        }

        if (!lectic.header.interlocutor.nocache) updateCache(messages)

        Logger.debug("anthropic - messages", messages)

        const model = lectic.header.interlocutor.model ?? 'us.anthropic.claude-sonnet-4-20250514-v1:0'

        let stream = this.client.messages.stream({
            system: systemPrompt(lectic),
            messages,
            model,
            temperature: lectic.header.interlocutor.temperature,
            max_tokens: lectic.header.interlocutor.max_tokens || 2048,
            tools: getTools(lectic)
        });

        let assistant = ""
        for await (const text of anthropicTextChunks(stream)) {
            yield text
            assistant += text
        }

        let msg = await stream.finalMessage()

        Logger.debug("anthropic - reply", msg)
        emitAssistantMessageEvent(assistant, lectic.header.interlocutor.name)

        if (msg.stop_reason == "tool_use") {
            yield* handleToolUse(msg, messages, lectic, this.client, model)
        } 
    },


    client : new AnthropicBedrock({ maxRetries: 5 }),

    provider : LLMProvider.AnthropicBedrock,

}
