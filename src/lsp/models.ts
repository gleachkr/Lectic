import type { Diagnostic } from "vscode-languageserver"
import { DiagnosticSeverity } from "vscode-languageserver/node"
import { LLMProvider } from "../types/provider"
import { AnthropicBackend } from "../backends/anthropic"
import { GeminiBackend } from "../backends/gemini"
import { OpenAIBackend } from "../backends/openai"
import { OpenAIResponsesBackend } from "../backends/openai-responses"
import { buildHeaderRangeIndex } from "./yamlRanges"
import { getYaml } from "../parsing/parse"
import { parseYaml, getValue, stringOf } from "./utils/yamlAst"
import { effectiveProviderForPath } from "./utils/provider"

// Simple background model registry with change listeners.
class ModelRegistry {
  private cache = new Map<LLMProvider, string[]>()
  private listeners = new Set<() => void>()
  private started = false

  start() {
    if (this.started) return
    this.started = true
    this.refreshAll()
  }

  onUpdate(cb: () => void): () => void {
    this.listeners.add(cb)
    return () => { this.listeners.delete(cb) }
  }

  get(provider: LLMProvider): string[] | undefined {
    return this.cache.get(provider)
  }

  private async refreshAll() {
    const tasks: Array<Promise<void>> = []

    // Anthropic
    if (process.env["ANTHROPIC_API_KEY"]) {
      tasks.push((new AnthropicBackend()).listModels().then(ms => {
        this.cache.set(LLMProvider.Anthropic, ms)
      }).catch(() => { /* ignore */ }))
    }

    // Anthropic via Bedrock — not enumerable; leave empty list
    // but still expose empty cache to mark as checked
    if (process.env["AWS_ACCESS_KEY_ID"] || process.env["AWS_PROFILE"]) {
      // Explicitly no-op: listModels returns [] by design
      this.cache.set(LLMProvider.AnthropicBedrock, [])
    }

    // Gemini
    if (process.env["GEMINI_API_KEY"]) {
      tasks.push(
        new GeminiBackend()
          .listModels()
          .then((ms: string[]) => {
            this.cache.set(LLMProvider.Gemini, ms)
          })
          .catch(() => {
            /* ignore */
          })
      )
    }

    // OpenAI Responses
    if (process.env["OPENAI_API_KEY"]) {
      const oai = new OpenAIResponsesBackend({
        apiKey: 'OPENAI_API_KEY',
        provider: LLMProvider.OpenAIResponses,
        defaultModel: 'gpt-5',
      })
      tasks.push(oai.listModels().then(ms => {
        this.cache.set(LLMProvider.OpenAIResponses, ms)
      }).catch(() => { /* ignore */ }))

      // The chat-completions compatible list often mirrors Responses.
      const oaiChat = new OpenAIBackend({
        apiKey: 'OPENAI_API_KEY',
        provider: LLMProvider.OpenAI,
        defaultModel: 'gpt-4o-mini',
      })
      tasks.push(oaiChat.listModels().then(ms => {
        this.cache.set(LLMProvider.OpenAI, ms)
      }).catch(() => { /* ignore */ }))
    }

    // OpenRouter
    if (process.env["OPENROUTER_API_KEY"]) {
      const or = new OpenAIBackend({
        apiKey: 'OPENROUTER_API_KEY',
        provider: LLMProvider.OpenRouter,
        defaultModel: 'google/gemini-2.5-flash',
        url: 'https://openrouter.ai/api/v1',
      })
      tasks.push(or.listModels().then(ms => {
        this.cache.set(LLMProvider.OpenRouter, ms)
      }).catch(() => { /* ignore */ }))
    }

    await Promise.allSettled(tasks)
    this.emit()
  }

  private emit() {
    for (const l of [...this.listeners]) {
      try { l() } catch { /* ignore listener errors */ }
    }
  }
}

export const modelRegistry = new ModelRegistry()

export function initModelRegistry() {
  modelRegistry.start()
}

export function onModelRegistryUpdate(cb: () => void): () => void {
  return modelRegistry.onUpdate(cb)
}

const ENUMERABLE_PROVIDERS = new Set<LLMProvider>([
  LLMProvider.Anthropic,
  LLMProvider.Gemini,
  LLMProvider.OpenAI,
  LLMProvider.OpenAIResponses,
  LLMProvider.OpenRouter,
])

export async function computeModelDiagnostics(
  docText: string,
  docDir?: string,
): Promise<Diagnostic[]> {
  const diags: Diagnostic[] = []
  const header = buildHeaderRangeIndex(docText)
  if (!header) return diags
  const yamlText = getYaml(docText) ?? ''
  const localDoc = parseYaml(yamlText).contents as unknown

  // Collect model fields in local header
  const modelFields = header.fieldRanges.filter(fr => {
    const last = fr.path[fr.path.length - 1]
    return last === 'model'
  })

  for (const f of modelFields) {
    const prov = await effectiveProviderForPath(docText, docDir, localDoc, f.path)
    if (!prov) continue
    if (!ENUMERABLE_PROVIDERS.has(prov)) continue

    const models = modelRegistry.get(prov)
    // Only warn on failures; silent while loading and on success
    if (models === undefined) continue

    // Read model value from local header using YAML AST helpers
    let modelName: string | undefined
    try {
      if (f.path[0] === 'interlocutor') {
        const it = getValue(localDoc, 'interlocutor')
        modelName = stringOf(getValue(it, 'model'))
      } else if (f.path[0] === 'interlocutors' && typeof f.path[1] === 'number') {
        const list = getValue(localDoc, 'interlocutors')
        const seq = (list as { items?: unknown })
        const arr = Array.isArray(seq?.items) ? (seq.items as unknown[]) : []
        const it = arr[f.path[1]]
        modelName = stringOf(getValue(it, 'model'))
      }
    } catch { /* ignore */ }

    if (!modelName || modelName.trim().length === 0) continue

    if (!models.includes(modelName)) {
      diags.push({
        range: f.range,
        severity: DiagnosticSeverity.Warning,
        source: 'lectic',
        message: `Unknown model for ${prov}.`
      })
    }
  }

  return diags
}
