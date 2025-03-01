//BUG: this needs to be a union of strings, so that it can be given in
//human-readable yaml- I think there's a way to do that as a TS enum
export enum LLMProvider {
    Anthropic = "anthropic",
    OpenAI = "openai",
    Ollama = "ollama",
}

export function isLLMProvider(raw : unknown) : raw is LLMProvider {
    return raw == LLMProvider.Anthropic ||
        raw == LLMProvider.OpenAI ||
        raw == LLMProvider.Ollama
}
