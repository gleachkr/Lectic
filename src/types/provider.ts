export enum LLMProvider {
    Anthropic = "anthropic",
    AnthropicBedrock = "anthropic/bedrock",
    OpenAI = "openai",
    OpenAIResponses = "openai/responses",
    Ollama = "ollama",
    Gemini = "gemini",
    OpenRouter = "openrouter",
}

export function getDefaultProvider() : LLMProvider {
    if ('ANTHROPIC_API_KEY' in process.env) return LLMProvider.Anthropic
    else if ('GEMINI_API_KEY' in process.env) return LLMProvider.Gemini
    else if ('OPENAI_API_KEY' in process.env) return LLMProvider.OpenAI
    else if ('OPENROUTER_API_KEY' in process.env) return LLMProvider.OpenRouter
    else throw new Error("Couldn't find a default provider. You probably need to set an API key for your preferred provider.")

}

export function isLLMProvider(raw : unknown) : raw is LLMProvider {
    return raw == LLMProvider.Anthropic ||
        raw == LLMProvider.AnthropicBedrock ||
        raw == LLMProvider.OpenAI ||
        raw == LLMProvider.Ollama ||
        raw == LLMProvider.OpenRouter ||
        raw == LLMProvider.OpenAIResponses ||
        raw == LLMProvider.Gemini
}
