import OpenAI from 'openai'
import type { Message } from "../types/message"
import type { Lectic } from "../types/lectic"
import { LLMProvider } from "../types/provider"
import type { Backend } from "../types/backend"
import { MessageAttachmentPart } from "../types/attachment"
import { Logger } from "../logging/logger"
import { serializeCall, ToolCallResults, type ToolCallResult } from "../types/tool"
import { systemPrompt, pdfFragment, emitAssistantMessageEvent,
    resolveToolCalls, collectAttachmentPartsFromCalls,
    gatherMessageAttachmentParts, computeCmdAttachments, isAttachmentMime, 
    emitUserMessageEvent} from './common.ts'
import { inlineFinal, serializeInlineAttachment, type InlineAttachment } from "../types/inlineAttachment"
import { strictify } from '../types/schema.ts'

const SUPPORTS_PROMPT_CACHE_RETENTION = [
    "gpt-5.1",
    "gpt-5.1-codex",
    "gpt-5.1-codex-mini",
    "gpt-5.1-chat-latest",
    "gpt-5",
    "gpt-4.1"
]


function getTools(lectic : Lectic) : OpenAI.Chat.Completions.ChatCompletionTool[] {
    const tools : OpenAI.Chat.Completions.ChatCompletionTool[] = []
    for (const tool of Object.values(lectic.header.interlocutor.registry ?? {})) {
        // https://platform.openai.com/docs/guides/structured-outputs/supported-schemas#supported-schemas
        // - defaults aren't supported
        // https://platform.openai.com/docs/guides/function-calling#strict-mode
        // in strict mode
        // - additionalProperties must be false on all objects
        // - all properties of each object must be required

        for (const key in tool.parameters) {
            if ("default" in tool.parameters[key]) {
                delete tool.parameters[key].default
            }
            tool.parameters[key] = strictify(tool.parameters[key])
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
    client : OpenAI,
    initialHookRes? : InlineAttachment[]) : AsyncGenerator<string | Message> {

    let loopCount = 0
    let finalPassCount = 0
    const registry = lectic.header.interlocutor.registry ?? {}
    const max_tool_use = lectic.header.interlocutor.max_tool_use ?? 10
    let currentHookRes = initialHookRes ?? []

    while (currentHookRes.filter(inlineFinal).length > 0 || message.tool_calls) {
        yield "\n\n"
        loopCount++

        if (loopCount > max_tool_use + 2) {
            yield "<error>Runaway tool use!</error>"
        }

        messages.push({
            name: lectic.header.interlocutor.name,
            role: "assistant",
            tool_calls: message.tool_calls,
            content: message.content
        })

        const entries = (message.tool_calls ?? [])
            .filter(call => call.type === "function")
            .map(call => {
                let args: unknown
                try { args = JSON.parse(call.function.arguments) } catch { args = undefined }
                return { id: call.id, name: call.function.name, args }
            })
        const realizedFunction = await resolveToolCalls(entries, registry, { limitExceeded: loopCount > max_tool_use, lectic })
        const realizedUnsupported = (message.tool_calls ?? [])
            .filter(call => call.type !== "function")
            .map(call => ({
                name: call.type,
                args: {},
                id: call.id,
                isError: true,
                results: ToolCallResults("<error>Unrecognized tool. non-function custom tools are not currently supported.</error>")
            }))
        const realized = [ ...realizedFunction, ...realizedUnsupported ]

        for (const call of message.tool_calls ?? []) {
            const realizedCall = realized.find(c => c.id === call.id)
            if (realizedCall && call.type === "function") {
                const theTool = call.function.name in registry 
                    ? registry[call.function.name] 
                    : null
                yield serializeCall(theTool, {
                    name: call.function.name,
                    args: JSON.parse(call.function.arguments), 
                    id: call.id,
                    isError: realizedCall.isError,
                    results: realizedCall.results
                })
                yield "\n\n"
            }
        }

        // Attach any non-text results via a user message with attachments
        {
            const parts = await collectAttachmentPartsFromCalls(realized, partToContent)
            for (const h of currentHookRes) {
                parts.push({ type: "text", text: h.content })
            }
            if (parts.length > 0) {
                messages.push({ role: 'user', content: parts })
            }
        }

        // also push provider tool result messages so the model can continue
        for (const call of message.tool_calls ?? []) {
            const realizedCall = realized.find(c => c.id === call.id)
            if (realizedCall && call.type === "function") {
                messages.push({
                    role: "tool",
                    tool_call_id: call.id,
                    content: realizedCall.results
                        .filter((r: ToolCallResult) => !isAttachmentMime(r.mimetype))
                        .map((r: ToolCallResult) => ({ type: "text" as const, text: r.toBlock().text }))
                })
            }
        }

        Logger.debug("openai - messages (tool)", messages)

        // model has been set at this point
        const model = lectic.header.interlocutor.model as string

        const stream = client.chat.completions.stream({
            messages: [developerMessage(lectic), ...messages],
            model,
            temperature: lectic.header.interlocutor.temperature,
            max_completion_tokens: lectic.header.interlocutor.max_tokens,
            prompt_cache_retention: SUPPORTS_PROMPT_CACHE_RETENTION.includes(model)
                ? "24h"
                : undefined,
            tools: getTools(lectic)
        })
    
        let assistant = ""
        for await (const event of stream) {
            const text = event.choices[0].delta.content || ""
            yield text
            assistant += text
        }

        const completion = await stream.finalChatCompletion()
        message = completion.choices[0].message
        const usageData = completion.usage
        const usage = usageData ? {
            input: usageData.prompt_tokens,
            output: usageData.completion_tokens,
            total: usageData.total_tokens
        } : undefined

        Logger.debug("openai - reply (tool)", message)
        const toolUseDone = !message.tool_calls
        currentHookRes = emitAssistantMessageEvent(assistant, lectic, 
            { toolUseDone, usage, loopCount, finalPassCount })
        if (currentHookRes.length > 0) {
             if (toolUseDone) finalPassCount++
             yield "\n\n"
             yield currentHookRes.map(serializeInlineAttachment).join("\n\n")
             yield "\n\n"
        }

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
                    file_data: `data:${media_type};base64,${Buffer.from(bytes).toString("base64")}`
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

async function handleMessage(
    msg : Message,
    opt?: { inlineAttachments?: InlineAttachment[] }
) : Promise<OpenAI.Chat.Completions.ChatCompletionMessageParam[]> {
    if (msg.role === "assistant") { 
        const results : OpenAI.Chat.Completions.ChatCompletionMessageParam[] = []
        const { interactions } = msg.parseAssistantContent()
        for (const interaction of interactions) {
            if (interaction.attachments.length > 0) {
                results.push({
                    role: "user",
                    content: interaction.attachments.map((a: InlineAttachment) => ({ type: "text" as const, text: a.content }))
                })
            }
            const modelParts : OpenAI.Chat.Completions.ChatCompletionContentPartText[] = []
            const toolCalls : OpenAI.Chat.Completions.ChatCompletionMessageToolCall[] = []
            if (interaction.text.length > 0) {
                modelParts.push({
                    type: "text" as const,
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

            if (interaction.calls.length > 0) {
                const attach = await collectAttachmentPartsFromCalls(interaction.calls, partToContent)
                if (attach.length > 0) {
                    results.push({ role: 'user', content: attach })
                }
            }

            for (const call of interaction.calls) {
                results.push({
                    role : "tool",
                    tool_call_id : call.id ?? "undefined",
                    content: call.results
                        .filter((r: ToolCallResult) => !isAttachmentMime(r.mimetype))
                        .map((r: ToolCallResult) => ({ type: "text" as const, text: r.toBlock().text }))})
            }
        }
        return results
    }

    const parts: MessageAttachmentPart[] = await gatherMessageAttachmentParts(msg)

    const content : OpenAI.Chat.Completions.ChatCompletionContentPart[] = [{
        type: "text" as const,
        text: msg.content
    }]

    for (const part of parts) {
        try {
            const source = await partToContent(part)
            if (source) content.push(source)
        } catch (e) {
            content.push({
                type: "text",
                text: `<error>Something went wrong while retrieving ${part.title}` +
                      `from ${part.URI}:${(e as Error).message}</error>`
            })
        }
    }

    if (opt?.inlineAttachments !== undefined) {
        const { textBlocks, inline } = await computeCmdAttachments(msg)
        for (const t of textBlocks) content.push({ type: "text", text: t })
        for (const t of opt.inlineAttachments) content.push({ type: "text", text: t.content })
        opt.inlineAttachments.push(...inline)
    }

    return [{ role : msg.role, content }]
}

function developerMessage(lectic : Lectic) {
    return {
        // OpenAI has moved to "developer" for this role, but so far they're
        // keeping backwards compatibility. Ollama however requires "system".
        // Probably other OAI compatible endpoints do too.
        // so we we'll use "system" until OAI descides to deprecate it.
        role : "system" as const,
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

        const messages : OpenAI.Chat.Completions.ChatCompletionMessageParam[] = []

        // Execute :cmd only if the last message is a user message
        const lastIdx = lectic.body.messages.length - 1
        const lastIsUser = lastIdx >= 0 && lectic.body.messages[lastIdx].role === "user"

        const inlineAttachments : InlineAttachment[] = []

        for (let i = 0; i < lectic.body.messages.length; i++) {
            const m = lectic.body.messages[i]
            if (m.role === "user" && lastIsUser && i === lastIdx) {
                inlineAttachments.push(...emitUserMessageEvent(m.content, lectic))
                messages.push(...await handleMessage(m, { inlineAttachments, }))
            } else {
                messages.push(...await handleMessage(m))
            }
        }

        Logger.debug("openai - messages", messages)

        lectic.header.interlocutor.model = lectic.header.interlocutor.model ?? this.defaultModel

        const stream = this.client.chat.completions.stream({
            messages: [developerMessage(lectic), ...messages],
            model: lectic.header.interlocutor.model,
            temperature: lectic.header.interlocutor.temperature,
            max_completion_tokens: lectic.header.interlocutor.max_tokens,
            prompt_cache_retention: SUPPORTS_PROMPT_CACHE_RETENTION.includes(lectic.header.interlocutor.model)
                ? "24h"
                : undefined,
            stream: true,
            tools: getTools(lectic)
        });

        // Emit cached inline attachments at the top of the assistant block
        if (inlineAttachments.length > 0) {
            const preface = inlineAttachments.map(serializeInlineAttachment).join("\n\n") + "\n\n"
            yield preface
        }

        let assistant = ""
        for await (const event of stream) {
            const text = event.choices[0].delta.content || ""
            yield text
            assistant += text
        }

        const completion = await stream.finalChatCompletion()
        const msg = completion.choices[0].message
        const usageData = completion.usage
        const usage = usageData ? {
            input: usageData.prompt_tokens,
            output: usageData.completion_tokens,
            total: usageData.total_tokens
        } : undefined

        Logger.debug(`${this.provider} - reply`, msg)
        const toolUseDone = !msg.tool_calls
        const assistantHookRes = emitAssistantMessageEvent(assistant, lectic, { toolUseDone, usage, loopCount: 0, finalPassCount: 0 })
        if (assistantHookRes.length > 0) {
             yield "\n\n"
             yield assistantHookRes.map(serializeInlineAttachment).join("\n\n")  
             yield "\n\n"
        }

        if (assistantHookRes.filter(inlineFinal).length > 0 || msg.tool_calls) {
            yield* handleToolUse(msg, messages, lectic, this.client, assistantHookRes);
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
