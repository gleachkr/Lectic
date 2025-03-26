import type { Lectic  } from "./lectic"
import type { Message } from "./message"
import { UserMessage } from "../types/message"
import { LLMProvider } from "./provider"

export type Backend = {

    evaluate(lectic : Lectic) : AsyncIterable<string | Message>,

    provider : LLMProvider,

}

export async function consolidateMemories(lectic : Lectic, backend : Backend) : Promise<Lectic> {

    lectic.body.messages.push(new UserMessage({
        content: 
            "Please summarize the conversation so far, for storage in memory." +
            "Include any details that would be necessary for continuing the conversation at a later date." +
            "Include any memories you had at the beginning of the conversation." +
            "State only the summary, do not include any commentary."
    }))

    let message : Message | undefined = undefined

    for await (const entry of backend.evaluate(lectic)) {
        if (typeof entry != "string") {
            message = entry
        }
    }

    lectic.header.interlocutor.memories = message?.content

    return lectic
}
