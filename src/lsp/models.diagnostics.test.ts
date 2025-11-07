import { describe, test, expect } from "bun:test"
import { computeModelDiagnostics, modelRegistry } from "./models"
import { LLMProvider } from "../types/provider"

function hasMessage(diags: any[], substr: string): boolean {
  return diags.some(d => typeof d?.message === 'string' && d.message.includes(substr))
}

describe("model diagnostics", () => {
  test("warns on unknown model for single interlocutor", async () => {
    const text = `---\ninterlocutor:\n  name: A\n  prompt: p\n  provider: anthropic\n  model: not-a-real-model\n---\nBody\n`
    // Seed registry with a known list for Anthropic
    ;(modelRegistry as any).cache = new Map([[LLMProvider.Anthropic, [
      "claude-3-haiku-20240307", "claude-3-5-sonnet"
    ]]])

    const diags = await computeModelDiagnostics(text)
    expect(diags.length).toBeGreaterThan(0)
    expect(hasMessage(diags, "Unknown model for anthropic")).toBeTrue()
  })

  test("warns on unknown model for interlocutors[i] with merged provider", async () => {
    const text = `---\ninterlocutors:\n  - name: B\n    prompt: p\n    provider: openai\n    model: gpt-does-not-exist\n---\nBody\n`
    ;(modelRegistry as any).cache = new Map([
      [LLMProvider.OpenAIResponses, ["gpt-4o-mini", "gpt-4o"]]
    ])
    const diags = await computeModelDiagnostics(text)
    expect(diags.length).toBeGreaterThan(0)
    expect(hasMessage(diags, "Unknown model for openai")).toBeTrue()
  })

  test("does not warn while models are still loading (undefined cache)", async () => {
    const text = `---\ninterlocutor:\n  name: A\n  prompt: p\n  provider: gemini\n  model: nonsense\n---\nBody\n`
    // Clear cache entirely -> undefined
    ;(modelRegistry as any).cache = new Map()
    const diags = await computeModelDiagnostics(text)
    expect(diags.length).toBe(0)
  })

  test("does not warn when model is in the registry list", async () => {
    const text = `---\ninterlocutor:\n  name: A\n  prompt: p\n  provider: gemini\n  model: gemini-2.5-flash\n---\nBody\n`
    ;(modelRegistry as any).cache = new Map([
      [LLMProvider.Gemini, ["gemini-2.5-flash"]]
    ])
    const diags = await computeModelDiagnostics(text)
    expect(diags.length).toBe(0)
  })
})
