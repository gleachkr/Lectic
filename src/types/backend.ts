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
            "State only the summary, do not include any commentary."
    }))

    let message : Message | undefined = undefined

    const current_interlocutor = lectic.header.interlocutor

    for (const interlocutor of lectic.header.interlocutors) {
        lectic.header.interlocutor = interlocutor
        for await (const entry of backend.evaluate(lectic)) {
            if (typeof entry != "string") {
                message = entry
            }
        }

        if (!lectic.header.interlocutor.memories) {
            lectic.header.interlocutor.memories = {}
        } else if (typeof lectic.header.interlocutor.memories == "string") {
            lectic.header.interlocutor.memories = {
                original_memories: lectic.header.interlocutor.memories
            }
        }

        const now = new Date()
        const date = `${now.toLocaleDateString('en-US')}-${now.toLocaleTimeString('en-US')}`

        lectic.header.interlocutor.memories[date] = message?.content || "no new memories"
    }

    lectic.header.interlocutor = current_interlocutor

    return lectic
}
