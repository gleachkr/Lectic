//monkey patch fetch to avoid timeout with some thinking models, codex
const originalFetch = globalThis.fetch
globalThis.fetch = Object.assign(
    function (req : string | URL | Request, opt? : RequestInit) { 
        const withTimeout: RequestInit & { timeout?: number | false } = opt
            ? { ...opt, timeout: false }
            : { timeout: false }
        return originalFetch(req, withTimeout)
    }, originalFetch)

import { program } from 'commander'
import { startLsp } from "./lsp/server"
import { LLMProvider } from "./types/provider"
import { AnthropicBackend } from "./backends/anthropic"
import { GeminiBackend } from "./backends/gemini"
import { OpenAIResponsesBackend } from "./backends/openai-responses"
import { OpenAIBackend } from "./backends/openai"
import { completions } from "./completions"

program
.name('lectic')
.option('-s, --short', 'Only emit a new message rather than the full updated lectic')
.option('-S, --Short', 'Only emit a new message rather than the full updated lectic. Only including the message text')
.option('-H, --header',  'Emit only the YAML header of the lectic')
.option('-f, --file <lectic>',  'Lectic to read from')
.option('-q, --quiet', 'Don’t print response')
.option('-i, --inplace <lectic>',  'Lectic to read from and update in place' )
.option('-l, --log <logfile>',  'Log debugging information')
.option('-v, --version',  'Print version information')
.action(async () => { await completions() })

program
.command('lsp')
.description('Start Lectic LSP server')
.action(async () => { await startLsp() })

program
.command('models')
.description('List available models for detected providers')
.action(async () => {
  const out: Array<{ name: string; models: string[] }> = []
  // Anthropic
  if (process.env['ANTHROPIC_API_KEY']) {
    const models = await new AnthropicBackend().listModels()
    out.push({ name: LLMProvider.Anthropic, models })
  }
  // Gemini
  if (process.env['GEMINI_API_KEY']) {
    const models = await GeminiBackend.listModels()
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
})

program.parse()
