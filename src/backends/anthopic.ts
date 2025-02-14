import Anthropic from '@anthropic-ai/sdk';
import { Lectic, Message } from "../types/lectic"
import { LLMProvider } from "../types/provider"
import { Backend } from "../types/backend"

function getText(msg : Anthropic.Messages.Message) : string {
    if (msg.content[0].type == "text") {
        return msg.content[0].text
    }

    if (msg.content[0].type == "tool_use") {
        return "Unhandled Tool Use"
    }

}

const systemPrompt = (lectic : Lectic) => `
Your name is ${lectic.header.interlocutor.name}

${lectic.header.interlocutor.prompt}

Use unicode rather than latex for mathematical notation. 

Line break at around 78 characters except in cases where this harms readability.`

export const AnthropicBackend : Backend & { client : Anthropic } = {
    async nextMessage(lectic : Lectic) : Promise<Message> {

      const msg = await (this.client as Anthropic).messages.create({
        max_tokens: 1024,
        system: systemPrompt(lectic),
        messages: lectic.body.messages,
        model: 'claude-3-5-sonnet-latest',
      });

      return {
          role : "assistant",
          content : getText(msg)
      }
    },

    provider : LLMProvider.Anthropic,

    client : new Anthropic({
        apiKey: process.env['ANTHROPIC_API_KEY'], // TODO api key on cli or in lectic
    }),
}
