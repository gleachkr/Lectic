import type { Content, Part, Tool, Schema, GenerateContentResult } from '@google/generative-ai'
import { GoogleGenerativeAI, SchemaType } from '@google/generative-ai'
import { Message } from "../types/message"
import type { Lectic } from "../types/lectic"
import type { JSONSchema } from "../types/tool"
import { LLMProvider } from "../types/provider"
import type { Backend } from "../types/backend"
import { FileLink } from "../types/link"
import { Logger } from "../logging/logger"
import { initRegistry, ToolRegistry } from "../types/tool_spec"
import { systemPrompt } from './util'

function googleParameter(param: JSONSchema ) : Schema | undefined {
    switch (param.type) {
        case "number" : return { type: SchemaType.NUMBER }
        case "integer" : return { type: SchemaType.INTEGER }
        case "boolean" : return { type: SchemaType.BOOLEAN }
        case "array" : return { 
            type: SchemaType.ARRAY,
            items: googleParameter(param.items) ?? { type: SchemaType.STRING }
        }
        case "object" : return { 
            type: SchemaType.OBJECT,
            properties: googleParameters(param.properties)
        }
    }
}

function googleParameters(params: { [key: string] : JSONSchema }) : { [key: string] : Schema } {
    const rslt : { [key: string] : Schema } = {}
    for (const key of Object.keys(params)) {
        const param = googleParameter(params[key])
        if (!param) throw Error("Google parameter cooercion failed")
        rslt[key] = param
    }
    return rslt
}

function getTools() : Tool[] {
    const tools : Tool[] = []
    for (const tool of Object.values(ToolRegistry)) {
        tools.push({
            functionDeclarations: [{
                  name : tool.name,
                  description : tool.description,
                  parameters: {
                      "type" : SchemaType.OBJECT,
                      "properties" : googleParameters(tool.parameters),
                      "required" : tool.required ?? [],
                 }
            }]
        })
    }
    return tools
}

async function handleToolUse(
    message : GenerateContentResult, 
    messages : Content[], 
    lectic : Lectic,
    client : GoogleGenerativeAI) : Promise<Message> {

    for (let recur = 12; recur >= 0; recur--) {
        const calls = message.response.functionCalls()
        if (!calls || calls.length == 0) break

        const model = client.getGenerativeModel({ 
            model: lectic.header.interlocutor.model || "gemini-2.0-flash",
            tools: getTools(),
            systemInstruction: systemPrompt(lectic),
        })

        messages.push({
            role: "model",
            parts: message.response.text().length > 0 
                ? [{ text: message.response.text() }, ...calls.map(call => ({ functionCall: call }))]
                : calls.map(call => ({ functionCall: call }))
        })

        const parts : Part[] = []

        for (const call of calls) {
            if (recur < 2) {
                parts.push({
                    functionResponse: {
                        name: call.name,
                        response: { 
                            name: call.name,
                            content: "<error>Tool usage limit exceeded, no further tool calls will be allowed</error>",
                        }
                    }
                })
            } else if (call.name in ToolRegistry) {
                await ToolRegistry[call.name].call(call.args)
                    .then(rslt => parts.push({
                        functionResponse: {
                            name: call.name,
                            response: {
                                name: call.name,
                                content: rslt
                            }
                        }
                    })).catch((e : Error) => parts.push({
                            functionResponse: {
                                name: call.name,
                                response: { 
                                    name: call.name,
                                    content: `<error>An Error Occurred: ${e.message}</error>`
                                }
                            }
                    }))
            }
        }

        messages.push({ role: "user", parts })

        Logger.log("gemini - messages (tool)", messages)

        message = await model.generateContent({
          contents: messages,
          generationConfig: {
              temperature: lectic.header.interlocutor.temperature,
              maxOutputTokens: lectic.header.interlocutor.max_tokens || 1024,
          }
        });

        Logger.log("gemini - reply (tool)", {
          text: message.response.text(),
          calls: message.response.functionCalls(),
          usage: message.response.usageMetadata,
          feedback: message.response.promptFeedback
        })

    }

    return new Message({
        role: "assistant", 
        content: message.response.text()
    })
}

async function linkToContent(link : FileLink) 
    : Promise<Part | null> {
    const media_type = await link.getType()
    const bytes = await link.getBytes()
    if (!(media_type && bytes)) return null
    // XXX seems like not all models support all mime types
    // cf https://ai.google.dev/gemini-api/docs/vision?hl=en&lang=node
    switch(media_type) {
        case "image/gif" : 
        case "image/jpeg": 
        case "image/webp": 
        case "image/heic": 
        case "image/heif": 
        case "image/png": 
        case "video/mp4":
        case "video/mpeg":
        case "video/mov":
        case "video/avi":
        case "video/x-flv":
        case "video/mpg":
        case "video/webm":
        case "video/wmv":
        case "video/3gpp":
        case "application/pdf":
        return {
            inlineData : {
                mimeType: media_type,
                data: Buffer.from(bytes).toString("base64")
            }
        } as const
        case "text/plain" : return {
            text: `<file title="${link.title}">${Buffer.from(bytes).toString()}</file>`
        } as const
        default: return null
    }
}

async function handleMessage(msg : Message) : Promise<Content> {
    const links = msg.containedLinks()

    if (msg.content.length == 0) {
        msg.content = "…"
    }

    if (links.length == 0 || msg.role != "user") {
        return {
            role: msg.role,
            parts: [{
                "text": msg.content
            }]
        }
    } else {
        const content : Part[] = [{
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
                        text: `<error>Something went wrong while retrieving ${file.title} from ${link}:${(e as Error).message}</error>`
                    })
                }
            }
        }
        return { role : msg.role, parts: content }
    }
}

export const GeminiBackend : Backend & { client : GoogleGenerativeAI} = {

    async nextMessage(lectic : Lectic) : Promise<Message> {

      if (lectic.header.interlocutor.tools) {
        initRegistry(lectic.header.interlocutor.tools)
      }

      const model = this.client.getGenerativeModel({ 
          model: lectic.header.interlocutor.model || "gemini-2.0-flash",
          tools: getTools(),
          systemInstruction: systemPrompt(lectic),
      })

      const messages : Content[] = []

      for (const msg of lectic.body.messages) {
          messages.push(await handleMessage(msg))
      }

      Logger.log("gemini - messages", messages)

      let msg = await model.generateContent({
        contents: messages,
        generationConfig: {
            temperature: lectic.header.interlocutor.temperature,
            maxOutputTokens: lectic.header.interlocutor.max_tokens || 1024,
        }
      });

      Logger.log("gemini - reply", {
          text: msg.response.text(),
          calls: msg.response.functionCalls(),
          usage: msg.response.usageMetadata,
          feedback: msg.response.promptFeedback
      })

      return handleToolUse(msg, messages, lectic, this.client)
    },

    provider : LLMProvider.Anthropic,

    client : new GoogleGenerativeAI(process.env['GEMINI_API_KEY'] || ""), //XXX subverting type system.

}
