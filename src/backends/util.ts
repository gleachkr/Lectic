import { getDefaultProvider, LLMProvider } from "../types/provider"
import type { Backend } from "../types/backend"
import { AnthropicBackend, AnthropicBedrockBackend } from "./anthropic"
import { OpenAIBackend } from "./openai"
import { OpenAIResponsesBackend } from "./openai-responses"
import { GeminiBackend } from "./gemini"
import type { Interlocutor } from "../types/interlocutor"

export function getBackend(interlocutor : Interlocutor) : Backend {
    switch (interlocutor.provider || getDefaultProvider()) {
        case LLMProvider.OpenAI:  return new OpenAIBackend({
            defaultModel: 'gpt-5',
            apiKey: 'OPENAI_API_KEY',
            provider: LLMProvider.OpenAI,
        })
        case LLMProvider.OpenRouter:  return new OpenAIBackend({
            defaultModel: 'google/gemini-2.5-flash',
            apiKey: 'OPENROUTER_API_KEY',
            provider: LLMProvider.OpenRouter,
            url: 'https://openrouter.ai/api/v1'
        })
        case LLMProvider.OpenAIResponses: return new OpenAIResponsesBackend({
            defaultModel: 'gpt-5',
            apiKey: 'OPENAI_API_KEY',
            provider: LLMProvider.OpenAIResponses,
        })
        case LLMProvider.Ollama: return new OpenAIBackend({
            defaultModel: 'llama3.2',
            apiKey: 'NO_API_KEY',
            provider: LLMProvider.Ollama,
            url: 'http://localhost:11434/v1' 
            //XXX Make configurable
        })
        case LLMProvider.Anthropic: return new AnthropicBackend()
        case LLMProvider.AnthropicBedrock: return new AnthropicBedrockBackend()
        case LLMProvider.Gemini: return GeminiBackend
    }
}
