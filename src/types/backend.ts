import type { Lectic  } from "./lectic"
import { Message } from "./message"
import { LLMProvider } from "./provider"

export type Backend = {

    nextMessage(lectic : Lectic) : Promise<Message>,

    provider : LLMProvider,

}

export async function consolidateMemories(lectic : Lectic, backend : Backend) : Promise<Lectic> {

    lectic.body.messages.push(new Message({
        role: "user",
        content: 
            "Please summarize the conversation so far, for storage in memory." +
            "Include any details that would be necessary for continuing the conversation at a later date." +
            "Include any memories you had at the beginning of the conversation." +
            "State only the summary, do not include any commentary."
    }))

    lectic.header.interlocutor.memories = (await backend.nextMessage(lectic)).content

    return lectic
}


