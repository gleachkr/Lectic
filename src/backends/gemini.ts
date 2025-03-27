import type { Content, Part, Schema, EnhancedGenerateContentResponse } from '@google/generative-ai'
import type * as Gemini from '@google/generative-ai' 
import { GoogleGenerativeAI, SchemaType } from '@google/generative-ai'
import type { Message } from "../types/message"
import { AssistantMessage } from "../types/message"
import type { Lectic } from "../types/lectic"
import type { JSONSchema } from "../types/tool"
import { serializeCall, Tool } from "../types/tool"
import { LLMProvider } from "../types/provider"
import type { Backend } from "../types/backend"
import { MessageAttachment } from "../types/attachment"
import { MessageCommand } from "../types/directive.ts"
import { Logger } from "../logging/logger"
import { systemPrompt } from './util'

function googleParameter(param: JSONSchema ) : Schema | undefined {
    switch (param.type) {
        case "string" : return { type: SchemaType.STRING }
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
        if (!param) throw Error("Google parameter coercion failed")
        rslt[key] = param
    }
    return rslt
}

function getTools() : Gemini.Tool[] {
    const tools : Gemini.Tool[] = []
    for (const tool of Object.values(Tool.registry)) {
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

async function *handleToolUse(
    response : EnhancedGenerateContentResponse, 
    messages : Content[], 
    lectic : Lectic,
    client : GoogleGenerativeAI) : AsyncGenerator<string | Message> {

    let calls = response.functionCalls()
    let recur = 0

    while (calls && calls.length > 0) {
        yield "\n\n"
        recur++

        if (recur > 12) {
            yield "<error>Runaway tool use!</error>"
            yield new AssistantMessage({ content: "<error>Runaway tool use!</error>" })
            return
        }

        const model = client.getGenerativeModel({ 
            model: lectic.header.interlocutor.model || "gemini-2.0-pro-exp-02-05",
            tools: getTools(),
            systemInstruction: systemPrompt(lectic),
        })

        messages.push({
            role: "model",
            parts: response.text().length > 0 
                ? [{ text: response.text() }, ...calls.map(call => ({ functionCall: call }))]
                : calls.map(call => ({ functionCall: call }))
        })

        const parts : Part[] = []

        for (const call of calls) {
            let result : string
            if (recur > 10) {
                result = "<error>Tool usage limit exceeded, no further tool calls will be allowed</error>"
            } else if (call.name in Tool.registry) {
                try {
                    result =  await Tool.registry[call.name].call(call.args)
                } catch (e : unknown) {
                    if (e instanceof Error) {
                        result = `<error>An Error Occurred: ${e.message}</error>`
                    } else {
                        throw e
                    }
                }
                yield serializeCall(Tool.registry[call.name], {
                    args: call.args, 
                    result
                })
                yield "\n\n"
            } else {
                result = `<error>Unrecognized tool name ${call.name}</error>`
            }
            parts.push({
                functionResponse: {
                    name: call.name,
                    response: {
                        name: call.name,
                        content: result
                    }
                }
            })
        }

        messages.push({ role: "user", parts })

        Logger.debug("gemini - messages (tool)", messages)

        const result = await model.generateContentStream({
          contents: messages,
          generationConfig: {
              temperature: lectic.header.interlocutor.temperature,
              maxOutputTokens: lectic.header.interlocutor.max_tokens || 1024,
          }
        });

        for await (const chunk of result.stream) {
            yield chunk.text()
        }

        response = await result.response

        Logger.debug("gemini - reply (tool)", {
          text: response.text(),
          calls: response.functionCalls(),
          usage: response.usageMetadata,
          feedback: response.promptFeedback
        })

        calls = response.functionCalls()

        yield new AssistantMessage({ content: response.text() })
    }

}

async function linkToContent(link : MessageAttachment) 
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
        case "audio/wav":
        case "audio/mp3":
        case "audio/mpeg":
        case "audio/x-m4a":
        case "audio/aiff":
        case "audio/aac":
        case "audio/ogg":
        case "audio/flac":
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
        default: return {
            text: `<error>Media type ${media_type} is not supported.</error>` 
        }
    }
}

async function handleMessage(msg : Message) : Promise<Content> {
    if (msg.role != "user") {
        return {
            role: "model",
            parts: [{
                "text": msg.content
            }]
        }
    }

    const links = msg.containedLinks().flatMap(MessageAttachment.fromGlob)
    const commands = msg.containedDirectives().map(d => new MessageCommand(d))

    if (msg.content.length == 0) { msg.content = "…" }

    const content : Part[] = [{ text: msg.content }]

    for (const link of links) {
        const exists = await link.exists()
        if (exists) {
            try {
                const source = await linkToContent(link)
                if (source) content.push(source)
            } catch (e) {
                content.push({
                    text:`<error>` +
                        `Something went wrong while retrieving ${link.title} from ${link.URI}:${(e as Error).message}` +
                    `</error>`
                })
            }
        }
    }

    for (const command of commands) {
        await command.execute()
        if (command.success) {
            content.push({
                text: `<stdout from="${command.command}">${command.stdout}</stdout>`
            })
        } else {
            content.push({
                text: `<error>Something went wrong when executing a command:` + 
                    `<stdout from="${command.command}">${command.stdout}</stdout>` +
                    `<stderr from="${command.command}">${command.stderr}</stderr>` +
                `</error>`
            })
        }
    }

    return { role : "user", parts: content }
}

export const GeminiBackend : Backend & { client : GoogleGenerativeAI} = {

    async *evaluate(lectic : Lectic) : AsyncIterable<string | Message> {

      const model = this.client.getGenerativeModel({ 
          model: lectic.header.interlocutor.model || "gemini-2.0-flash",
          tools: getTools(),
          systemInstruction: systemPrompt(lectic),
      })

      const messages : Content[] = []

      for (const msg of lectic.body.messages) {
          messages.push(await handleMessage(msg))
      }

      Logger.debug("gemini - messages", messages)

      let result = await model.generateContentStream({
        contents: messages,
        generationConfig: {
            temperature: lectic.header.interlocutor.temperature,
            maxOutputTokens: lectic.header.interlocutor.max_tokens || 1024,
        }
      });

      for await (const chunk of result.stream) {
          yield chunk.text()
      }

      const msg = await result.response

      Logger.debug("gemini - reply", {
          text: msg.text(),
          calls: msg.functionCalls(),
          usage: msg.usageMetadata,
          feedback: msg.promptFeedback
      })

      const calls = msg.functionCalls()

      if (calls && calls.length > 0) {
          yield* handleToolUse(msg, messages, lectic, this.client);
      } else {
          yield new AssistantMessage({ content: msg.text() })
      }
    },

    provider : LLMProvider.Anthropic,

    client : new GoogleGenerativeAI(process.env['GEMINI_API_KEY'] || ""), //XXX subverting type system.

}
