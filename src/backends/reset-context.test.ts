import { describe, expect, test } from "bun:test"

import { AnthropicBackend } from "./anthropic"
import { GeminiBackend } from "./gemini"
import { OpenAIResponsesBackend } from "./openai-responses"
import { OpenAIBackend } from "./openai"
import { serializeInlineAttachment } from "../types/inlineAttachment"
import type { Lectic } from "../types/lectic"
import { AssistantMessage, type Message } from "../types/message"
import { LLMProvider } from "../types/provider"

type ReplayBackend = {
  handleMessage(
    message: Message,
    lectic: Lectic,
  ): Promise<{ messages: unknown[]; reset: boolean }>
}

function resetMessage(): AssistantMessage {
  const reset = serializeInlineAttachment({
    kind: "hook",
    command: "reset-context",
    content: "Replacement context for the next session.",
    mimetype: "text/plain",
    attributes: { reset: "true" },
  })

  return new AssistantMessage({
    content: `This assistant response must be discarded.\n\n${reset}`,
    interlocutor: {
      name: "Assistant",
      prompt: "Test prompt",
    },
  })
}

function lecticStub(): Lectic {
  return {
    header: {
      interlocutor: {
        name: "Assistant",
        prompt: "Test prompt",
      },
    },
  } as Lectic
}

const providers: Array<{ name: string; backend: ReplayBackend }> = [
  {
    name: "Anthropic",
    backend: new AnthropicBackend("test-key") as unknown as ReplayBackend,
  },
  {
    name: "OpenAI Chat",
    backend: new OpenAIBackend({
      provider: LLMProvider.OpenAI,
      defaultModel: "test-model",
      apiKeyEnv: "OPENAI_API_KEY",
      apiKeyValue: "test-key",
    }) as unknown as ReplayBackend,
  },
  {
    name: "OpenAI Responses",
    backend: new OpenAIResponsesBackend({
      provider: LLMProvider.OpenAI,
      defaultModel: "test-model",
      apiKeyEnv: "OPENAI_API_KEY",
      apiKeyValue: "test-key",
    }) as unknown as ReplayBackend,
  },
  {
    name: "Gemini",
    backend: new GeminiBackend("test-key") as unknown as ReplayBackend,
  },
]

describe("provider reset replay", () => {
  for (const provider of providers) {
    test(`${provider.name} keeps only reset replacement context`, async () => {
      const replayed = await provider.backend.handleMessage(
        resetMessage(),
        lecticStub(),
      )
      const serialized = JSON.stringify(replayed.messages)

      expect(replayed.reset).toBe(true)
      expect(replayed.messages).toHaveLength(1)
      expect(serialized).toContain("Replacement context")
      expect(serialized).not.toContain("must be discarded")
    })
  }
})
