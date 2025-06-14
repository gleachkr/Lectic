import { getDefaultProvider, LLMProvider } from "../types/provider"
import type { Backend } from "../types/backend"
import { AnthropicBackend } from "./anthropic"
import { OpenAIBackend } from "./openai"
import { OpenAIResponsesBackend } from "./openai-responses"
import { OllamaBackend } from "./ollama"
import { GeminiBackend } from "./gemini"
import type { Interlocutor } from "../types/interlocutor"

export function getBackend(interlocutor : Interlocutor) : Backend {
    switch (interlocutor.provider || getDefaultProvider()) {
        case LLMProvider.OpenAI:  return new OpenAIBackend({
            defaultModel: 'gpt-4.1',
            apiKey: 'OPENAI_API_KEY',
            provider: LLMProvider.OpenAI,
        })
        case LLMProvider.OpenRouter:  return new OpenAIBackend({
            defaultModel: 'google/gemini-2.5-flash-preview',
            apiKey: 'OPENROUTER_API_KEY',
            provider: LLMProvider.OpenRouter,
            url: 'https://openrouter.ai/api/v1'
        })
        case LLMProvider.OpenAIResponses: return new OpenAIResponsesBackend({
            defaultModel: 'gpt-4.1',
            apiKey: 'OPENAI_API_KEY',
            provider: LLMProvider.OpenAIResponses,
        })
        case LLMProvider.Ollama: return OllamaBackend
        case LLMProvider.Anthropic: return AnthropicBackend
        case LLMProvider.Gemini: return GeminiBackend
    }
}
