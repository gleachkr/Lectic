import { describe, test, expect } from "bun:test"
import { AnthropicBackend, AnthropicBedrockBackend } from "./anthropic"
import { GeminiBackend } from "./gemini"
import { OpenAIBackend } from "./openai"
import { OpenAIResponsesBackend } from "./openai-responses"
import { LLMProvider } from "../types/provider"

function asyncIterableFrom<T>(items: T[]) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const it of items) yield it
    }
  }
}

describe("backend model listing", () => {
  test("Anthropic models.list supports async iteration", async () => {
    const orig = AnthropicBackend.client
    try {
      (AnthropicBackend as any).client = {
        models: {
          list: async () => asyncIterableFrom([ { id: "claude-3-haiku-20240307" }, { id: "claude-3-5-sonnet" } ])
        }
      }
      const ids = await AnthropicBackend.listModels()
      expect(ids).toEqual(["claude-3-haiku-20240307", "claude-3-5-sonnet"])
    } finally {
      ;(AnthropicBackend as any).client = orig
    }
  })

  test("Gemini models.list supports async iteration", async () => {
    const orig = GeminiBackend.client
    try {
      (GeminiBackend as any).client = {
        models: {
          list: async () => asyncIterableFrom([ 
              { 
                  name: "gemini-2.5-flash",
                  supportedActions: ["generateContent"]

              }, { 
                  name: "gemini-1.5-pro",
                  supportedActions: ["generateContent"]
              } ])
        }
      }
      const ids = await GeminiBackend.listModels()
      expect(ids).toEqual(["gemini-2.5-flash", "gemini-1.5-pro"])
    } finally {
      ;(GeminiBackend as any).client = orig
    }
  })

  test("OpenAI Chat backend uses async iterable page", async () => {
    const backend = new OpenAIBackend({
      apiKey: "OPENAI_API_KEY",
      provider: LLMProvider.OpenAI,
      defaultModel: "gpt-4o-mini"
    })
    const fakeClient = {
      models: {
        list: async () => asyncIterableFrom([ { id: "gpt-4o-mini" }, { id: "gpt-4o" } ])
      }
    }
    try {
      Object.defineProperty(backend as any, "client", { get: () => fakeClient, configurable: true })
      const ids = await backend.listModels()
      expect(ids).toEqual(["gpt-4o-mini", "gpt-4o"])
    } finally {
      // Remove instance override to fall back to prototype getter
      delete (backend as any).client
    }
  })

  test("OpenAI Responses backend uses async iterable page", async () => {
    const backend = new OpenAIResponsesBackend({
      apiKey: "OPENAI_API_KEY",
      provider: LLMProvider.OpenAIResponses,
      defaultModel: "gpt-4o-mini"
    })
    const fakeClient = {
      models: {
        list: async () => asyncIterableFrom([ { id: "gpt-4o-mini" } ])
      }
    }
    try {
      Object.defineProperty(backend as any, "client", { get: () => fakeClient, configurable: true })
      const ids = await backend.listModels()
      expect(ids).toEqual(["gpt-4o-mini"])
    } finally {
      delete (backend as any).client
    }
  })

  test("Anthropic Bedrock returns empty list", async () => {
    const ids = await AnthropicBedrockBackend.listModels()
    expect(ids).toEqual([])
  })
})
