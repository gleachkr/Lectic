import type { Lectic  } from "./lectic"
import type { Message } from "./message"
import { LLMProvider } from "./provider"

export type Backend = {

    evaluate(lectic : Lectic) : AsyncIterable<string | Message>,

    provider : LLMProvider,

}
