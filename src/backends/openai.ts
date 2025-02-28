import OpenAI from 'openai'
import { Message } from "../types/message"
import type { Lectic } from "../types/lectic"
import { LLMProvider } from "../types/provider"
import type { Backend } from "../types/backend"
import { FileLink } from "../types/link"
import { initRegistry, ToolRegistry } from "../types/tool_spec"
import { systemPrompt } from './util'

function getText(msg : OpenAI.Chat.ChatCompletion) : string {
    return msg.choices[0].message.content ?? "…"
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

async function handleToolUse(
    message : OpenAI.Chat.ChatCompletion, 
    messages : OpenAI.Chat.Completions.ChatCompletionMessageParam[], 
    lectic : Lectic,
    client : OpenAI) : Promise<Message> {

    let text_results = ""

    for (let max_recur = 10; max_recur >= 0; max_recur--) {
        if (!message.choices[0].message.tool_calls) break

        messages.push({
            role: "assistant",
            content: message.choices[0].message.content
        })


        for (const call of message.choices[0].message.tool_calls) {
            if (call.function.name in ToolRegistry) {
                 // TODO error handling
                const inputs = JSON.parse(call.function.arguments)
                ToolRegistry[call.function.name].call(inputs)
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

        text_results += `${getText(message)}\n\n`

        message = await (client as OpenAI).chat.completions.create({
            max_tokens: 1024,
            messages: messages.concat([developerMessage(lectic)]),
            model: lectic.header.interlocutor.model ?? 'gpt-4o',
            tools: getTools()
        });
    }

    return new Message({
        role: "assistant", 
        content: text_results + getText(message)
    })
}

async function linkToContent(link : FileLink) 
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
            type : "text", 
            text: `<error>couldn't upload ${link.title}. PDFs are not currently supported</error>`
        } as const
        default: 
        case "text/plain" : return {
            type : "text", 
            text: `<file title="${link.title}">${Buffer.from(bytes).toString()}</file>`
        } as const
    }
}

async function handleMessage(msg : Message) : Promise<OpenAI.Chat.Completions.ChatCompletionMessageParam> {
    const links = msg.containedLinks()
    if (links.length == 0 || msg.role != "user") {
        return msg
    } else {
        const content : OpenAI.Chat.Completions.ChatCompletionContentPart[] = [{
            type: "text" as "text",
            text: msg.content
        }]
        for (const link of links) {
            const file = new FileLink(link)
            const exists = await file.exists()
            if (exists) {
                try {
                    const source = await linkToContent(file)
                    if (source) content.push(source)
                } catch (e) {
                    content.push({
                        type: "text",
                        text: `<error>Something went wrong while retrieving ${file.title} from ${link}:${(e as Error).message}</error>`
                    })
                }
            }
        }
        return { role : msg.role, content }
    }
}

function developerMessage(lectic : Lectic) {
    return {
        role : "developer" as "developer",
        content: systemPrompt(lectic)
    }
}

export const OpenAIBackend : Backend & { client : OpenAI} = {

    async nextMessage(lectic : Lectic) : Promise<Message> {

      if (lectic.header.interlocutor.tools) {
        initRegistry(lectic.header.interlocutor.tools)
      }

      const messages : OpenAI.Chat.Completions.ChatCompletionMessageParam[] = []

      for (const msg of lectic.body.messages) {
          messages.push(await handleMessage(msg))
      }

      let msg = await (this.client as OpenAI).chat.completions.create({
        messages: messages.concat([developerMessage(lectic)]),
        model: lectic.header.interlocutor.model || 'gpt-4o',
        temperature: lectic.header.interlocutor.temperature,
        max_tokens: lectic.header.interlocutor.max_tokens || 1024,
        tools: getTools()
      });

      return handleToolUse(msg, messages, lectic, this.client)
    },

    provider : LLMProvider.Anthropic,

    client : new OpenAI({
        apiKey: process.env['OPENAI_API_KEY'], // TODO api key on cli or in lectic
    }),

}
