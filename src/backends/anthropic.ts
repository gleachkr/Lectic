import Anthropic from '@anthropic-ai/sdk';
import { AnthropicBedrock } from '@anthropic-ai/bedrock-sdk';
import type { Message } from "../types/message"
import type { Lectic } from "../types/lectic"
import { serializeCall } from "../types/tool"
import type { ToolCall, ToolCallResult } from "../types/tool"
import { LLMProvider } from "../types/provider"
import type { Backend } from "../types/backend"
import { MessageAttachmentPart } from "../types/attachment"
import { Logger } from "../logging/logger"
import { systemPrompt, wrapText, pdfFragment, emitAssistantMessageEvent,
    resolveToolCalls, collectAttachmentPartsFromCalls,
    gatherMessageAttachmentParts, computeCmdAttachments, isAttachmentMime, 
    emitUserMessageEvent} from "./common.ts"
import { inlineNotFinal, inlineReset, serializeInlineAttachment, type InlineAttachment } from "../types/inlineAttachment"
import type { MessageStream } from '@anthropic-ai/sdk/lib/MessageStream.mjs';

// Yield only text deltas from an Anthropic stream, plus blank lines when
// server tool use blocks begin (to preserve formatting semantics).
export async function* anthropicTextChunks(
    stream: MessageStream
) : AsyncGenerator<string> {
    for await (const messageEvent of stream) {
        if (messageEvent.type === 'content_block_delta' &&
            messageEvent.delta.type === "text_delta") {
            yield messageEvent.delta.text
        }
        if (messageEvent.type === 'content_block_start' &&
            messageEvent.content_block?.type === 'server_tool_use') {
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


async function handleMessage(
    msg : Message,
    lectic: Lectic,
    opt?: { inlineAttachments?: InlineAttachment[] }
) : Promise<{ messages: Anthropic.Messages.MessageParam[], reset: boolean }> {
    if (msg.role === "assistant" && msg.name === lectic.header.interlocutor.name) {
        const results : Anthropic.Messages.MessageParam[] = []
        let reset = false
        const { interactions } = msg.parseAssistantContent()
        for (const interaction of interactions) {
            if (interaction.attachments.some(inlineReset)) {
                results.length = 0
                reset = true
            }

            if (interaction.attachments.length > 0) {
                results.push({
                    role: "user",
                    content: interaction.attachments.map(a => ({ type: "text" as const, text: a.content }))
                })
            }
            const modelParts : Anthropic.Messages.ContentBlockParam[] = []
            const userParts : Anthropic.Messages.ContentBlockParam[] = []
            if (interaction.text.length > 0) {
                modelParts.push({
                    type: "text" as const,
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
                        content: call.results
                            .filter(r => !isAttachmentMime(r.mimetype))
                            .map(r => ({ type: "text" as const, text: r.toBlock().text })),
                        is_error: call.isError,
                    })
                }

                // Merge attachments after tool_result blocks in the same
                // user message so Anthropic accepts the ordering.
                userParts.push(
                    ...await collectAttachmentPartsFromCalls(interaction.calls, partToContent)
                )
            }

            // could have empty model parts if it's a pure inline attachment
            if (modelParts.length > 0) {
                results.push({ role: "assistant", content: modelParts })
            }
            if (userParts.length > 0) {
                results.push({ role : "user", content: userParts })
            }
        }

        return { messages: results, reset }
    } else if (msg.role === "assistant") {
        return { messages: [{
            role : "user",
            content: [{
                type: "text",
                text: wrapText({
                    text: msg.content || "…",
                    name: msg.name
                })}]
        }], reset: false }
    } else {

        const parts: MessageAttachmentPart[] = await gatherMessageAttachmentParts(msg)

        const content : Anthropic.Messages.ContentBlockParam[] = [{
            type: "text" as const,
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

        if (opt?.inlineAttachments !== undefined) {
            const { textBlocks, inline } = await computeCmdAttachments(msg)
            for (const t of textBlocks) content.push({ type: "text", text: t })
            for (const t of opt.inlineAttachments) content.push({ type: "text", text: t.content })
            opt.inlineAttachments.push(...inline)
        }

        return { messages: [{ role : msg.role, content }], reset: false }
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

async function* runConversationLoop(
    opt: {
        messages: Anthropic.Messages.MessageParam[]
        lectic: Lectic
        client: Anthropic | AnthropicBedrock
        inlinePreface: InlineAttachment[]
    }
) : AsyncGenerator<string | Message> {

    const messages = opt.messages
    const lectic = opt.lectic
    const client = opt.client
    // model has been set at this point
    const model = opt.lectic.header.interlocutor.model as string

    const registry = lectic.header.interlocutor.registry ?? {}
    const maxToolUse = lectic.header.interlocutor.max_tool_use ?? 10

    let loopCount = 0
    let finalPassCount = 0

    // Preface inline attachments at the top of the assistant block.
    if (opt.inlinePreface.length > 0) {
        const preface = opt.inlinePreface
            .map(serializeInlineAttachment)
            .join("\n\n") + "\n\n"
        yield preface
    }

    let pendingHookRes: InlineAttachment[] = []

    for (;;) {
        if (!lectic.header.interlocutor.nocache) updateCache(messages)

        Logger.debug("anthropic - messages", messages)

        const stream = client.messages.stream({
            max_tokens: lectic.header.interlocutor.max_tokens || 2048,
            system: systemPrompt(lectic),
            messages: messages,
            model,
            temperature: lectic.header.interlocutor.temperature,
            tools: getTools(lectic),
            thinking: lectic.header.interlocutor.thinking_budget !== undefined ? {
                type: 'enabled',
                budget_tokens: lectic.header.interlocutor.thinking_budget
            } : undefined
        })

        let assistant = ""
        for await (const text of anthropicTextChunks(stream)) {
            yield text
            assistant += text
        }

        const msg = await stream.finalMessage()

        Logger.debug("anthropic - reply", msg)

        const toolUseDone = msg.stop_reason !== "tool_use"
        const input = msg.usage.input_tokens + 
            (msg.usage.cache_read_input_tokens ?? 0) + 
            (msg.usage.cache_creation_input_tokens ?? 0)
        const usage = {
            input,
            cached: msg.usage.cache_read_input_tokens ?? 0,
            output: msg.usage.output_tokens,
            total: input + msg.usage.output_tokens
        }

        pendingHookRes = emitAssistantMessageEvent(assistant, lectic, {
            toolUseDone,
            usage,
            loopCount,
            finalPassCount,
        })

        if (pendingHookRes.length > 0) {
            if (toolUseDone) finalPassCount++
            yield "\n\n"
            yield pendingHookRes.map(serializeInlineAttachment).join("\n\n")
            yield "\n\n"
        }

        const needsFollowUp =
            msg.stop_reason == "tool_use" ||
            pendingHookRes.filter(inlineNotFinal).length > 0

        if (!needsFollowUp) return

        yield "\n\n"
        loopCount++

        if (loopCount > maxToolUse + 2) {
            yield "<error>Runaway tool use!</error>"
            return
        }

        const resetAttachments = pendingHookRes.filter(inlineReset)
        if (resetAttachments.length > 0) {
            messages.length = 0
            messages.push({
                role: "user",
                content: resetAttachments.map(h => ({
                    type: "text" as const,
                    text: h.content
                }))
            })
        }

        messages.push({
            role: "assistant",
            content: msg.content
        })

        const toolUses = msg.content.filter(block => block.type == "tool_use")
        const entries = toolUses.map(block => ({
            id: block.id,
            name: block.name,
            args: block.input,
        }))

        const realized: ToolCall[] = await resolveToolCalls(entries, registry, {
            limitExceeded: loopCount > maxToolUse,
            lectic
        })

        // Convert to Anthropic blocks for the API.
        const content: Anthropic.Messages.ContentBlockParam[] = realized.map(
            (call: ToolCall) => ({
                type: "tool_result" as const,
                tool_use_id: call.id ?? "",
                is_error: call.isError,
                content: call.results
                    .filter((r: ToolCallResult) => !isAttachmentMime(r.mimetype))
                    .map((r: ToolCallResult) => ({
                        type: "text" as const,
                        text: r.toBlock().text
                    }))
            })
        )

        // Yield results to the transcript, preserving mimetypes.
        for (const block of toolUses) {
            const call = realized.find((c: ToolCall) => c.id === block.id)
            if (call && block.input instanceof Object) {
                const theTool = block.name in registry ? registry[block.name] : null
                yield serializeCall(theTool, {
                    name: block.name,
                    args: block.input as Record<string, unknown>,
                    id: block.id,
                    isError: call.isError,
                    results: call.results
                }) + "\n\n"
            }
        }

        // Merge attachments after tool_result blocks in the same user message.
        content.push(...await collectAttachmentPartsFromCalls(realized, partToContent))

        for (const h of pendingHookRes.filter(h => !inlineReset(h))) {
            content.push({ type: "text", text: h.content })
        }

        if (content.length > 0) messages.push({ role: "user", content })

        // Loop continues with updated messages.
    }
}

export class AnthropicBackend implements Backend {

    provider: LLMProvider
    defaultModel: string
    client: Anthropic | AnthropicBedrock

    constructor() {
        this.provider = LLMProvider.Anthropic
        this.defaultModel = 'claude-sonnet-4-20250514'
        this.client = new Anthropic({
            apiKey: process.env['ANTHROPIC_API_KEY'], // TODO api key on cli or in lectic
            maxRetries: 5,
        })
    }

    async listModels(): Promise<string[]> {
        // Bedrock model enumeration via Anthropic SDK is not supported
        // here. Return an empty list for now.
        if (!("models" in this.client)) return []
        try {
            const page = await this.client.models.list()
            const ids: string[] = []
            for await (const m of page) ids.push(m.id)
            return ids
        } catch (_e) {
            return []
        }
    }

    async *evaluate(lectic : Lectic) : AsyncIterable<string | Message> {

        const messages : Anthropic.Messages.MessageParam[] = []

        // Execute :cmd only if the last message is a user message
        const lastIdx = lectic.body.messages.length - 1
        const lastIsUser = lastIdx >= 0 && lectic.body.messages[lastIdx].role === "user"

        const inlineAttachments : InlineAttachment[] = []

        for (let i = 0; i < lectic.body.messages.length; i++) {
            const m = lectic.body.messages[i]
            if (m.role === "user" && lastIsUser && i === lastIdx) {
                inlineAttachments.push(...emitUserMessageEvent(m.content, lectic))

                const { messages: newMsgs } = await handleMessage(m, lectic, {
                    inlineAttachments,
                })
                messages.push(...newMsgs)
            } else {
                const { messages: newMsgs, reset } = await handleMessage(m, lectic)
                if (reset) messages.length = 0
                messages.push(...newMsgs)
            }
        }

        lectic.header.interlocutor.model =
            lectic.header.interlocutor.model ?? this.defaultModel

        yield* runConversationLoop({
            messages,
            lectic,
            client: this.client,
            inlinePreface: inlineAttachments,
        })
    }
}

export class AnthropicBedrockBackend extends AnthropicBackend {

    client: AnthropicBedrock

    constructor() {
        super()
        this.provider = LLMProvider.AnthropicBedrock
        this.defaultModel = 'us.anthropic.claude-sonnet-4-20250514-v1:0'
        this.client = new AnthropicBedrock({ maxRetries: 5 })
    }
}
