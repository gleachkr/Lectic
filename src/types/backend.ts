import type { Lectic  } from "./lectic"
import type { Message } from "./message"
import { LLMProvider } from "./provider"

export type Backend = {

    nextMessage(lectic : Lectic) : Promise<Message>,

    provider : LLMProvider,

}
