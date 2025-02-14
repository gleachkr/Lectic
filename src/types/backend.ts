import { Lectic, Message } from "./lectic"
import { LLMProvider } from "./provider.ts"

export type Backend = {

    nextMessage(lectic : Lectic) : Promise<Message>,

    provider : LLMProvider,

}
