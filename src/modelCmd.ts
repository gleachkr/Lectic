import { LLMProvider } from "./types/provider"
import { AnthropicBackend } from "./backends/anthropic"
import { GeminiBackend } from "./backends/gemini"
import { OpenAIResponsesBackend } from "./backends/openai-responses"
import { OpenAIBackend } from "./backends/openai"
import { CodexBackend } from "./backends/codex"
import { CodexAuth } from "./auth/codex"

export async function listModels() {
  const out: Array<{ name: string; models: string[] }> = []
  // Anthropic
  if (process.env['ANTHROPIC_API_KEY']) {
    const models = await new AnthropicBackend().listModels()
    out.push({ name: LLMProvider.Anthropic, models })
  }
  // Gemini
  if (process.env['GEMINI_API_KEY']) {
    const models = await new GeminiBackend().listModels()
    out.push({ name: LLMProvider.Gemini, models })
  }
  // OpenAI (Responses)
  if (process.env['OPENAI_API_KEY']) {
    const openai = new OpenAIResponsesBackend({
      apiKey: 'OPENAI_API_KEY',
      provider: LLMProvider.OpenAIResponses,
      defaultModel: 'gpt-5',
    })
    const models = await openai.listModels()
    out.push({ name: LLMProvider.OpenAIResponses, models })
  }
  // OpenRouter
  if (process.env['OPENROUTER_API_KEY']) {
    const openrouter = new OpenAIBackend({
      apiKey: 'OPENROUTER_API_KEY',
      provider: LLMProvider.OpenRouter,
      defaultModel: 'google/gemini-2.5-flash',
      url: 'https://openrouter.ai/api/v1',
    })
    const models = await openrouter.listModels()
    out.push({ name: LLMProvider.OpenRouter, models })
  }

  // Codex
  const chatgptAuth = new CodexAuth()
  if (chatgptAuth.isAuthenticated()) {
    const chatgpt = new CodexBackend()
    const models = await chatgpt.listModels()
    out.push({ name: LLMProvider.Codex , models })
  }

  if (out.length === 0) {
    console.log('No known provider API keys detected.')
    process.exit(0)
  }

  for (const entry of out) {
    console.log(entry.name)
    for (const m of entry.models) console.log(`- ${m}`)
    if (entry.models.length === 0) console.log('- (none)')
    console.log('')
  }
}
