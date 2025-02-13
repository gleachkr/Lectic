export enum LLMProvider {
    Anthropic
}

export function isLLMProvider(raw : unknown) : raw is LLMProvider {
    return raw == LLMProvider.Anthropic
}
