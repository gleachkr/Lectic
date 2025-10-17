import type { Lectic  } from "./lectic"
import type { Message } from "./message"
import { LLMProvider } from "./provider"

export type Backend = {

    evaluate(lectic : Lectic) : AsyncIterable<string | Message>,

    provider : LLMProvider,

    // List available model identifiers for this backend/provider.
    // Implementations should use the provider SDK (no direct fetch).
    // May return an empty list when unsupported (e.g., Bedrock for now).
    listModels(): Promise<string[]>,
}
