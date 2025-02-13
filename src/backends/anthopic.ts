import Anthropic from '@anthropic-ai/sdk';

export function getText(msg : Anthropic.Messages.Message) : string {
    if (msg.content[0].type == "text") {
        return msg.content[0].text
    }

    if (msg.content[0].type == "tool_use") {
        return "Unhandled Tool Use"
    }
}
