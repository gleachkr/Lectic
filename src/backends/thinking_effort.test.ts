import { describe, expect, test } from "bun:test"
import { AnthropicBackend } from "./anthropic"
import { GeminiBackend } from "./gemini"
import type { ThinkingEffort } from "../types/thinkingEffort"

class TestAnthropicBackend extends AnthropicBackend {
  constructor(fakeClient: unknown) {
    super("test-key")
    this.client = fakeClient as any
  }

  createForTest(lectic: unknown) {
    return this.createCompletion({ messages: [], lectic: lectic as any })
  }
}

class TestGeminiBackend extends GeminiBackend {
  constructor(fakeClient: unknown) {
    super("test-key")
    this.client = fakeClient as any
  }

  createForTest(lectic: unknown) {
    return this.createCompletion({ messages: [], lectic: lectic as any })
  }
}

function makeLectic(thinking_effort: ThinkingEffort) {
  return {
    header: {
      interlocutor: {
        name: "Assistant",
        prompt: "Be helpful.",
        model: "test-model",
        registry: {},
        tools: [],
        thinking_effort,
      },
    },
  }
}

describe("Anthropic thinking effort", () => {
  test.each(["xhigh", "max"] as const)(
    "passes %s through as an adaptive effort",
    async (effort) => {
      let seen: Record<string, any> | undefined
      const backend = new TestAnthropicBackend({
        messages: {
          stream(args: Record<string, any>) {
            seen = args
            return {
              finalMessage: async () => ({ content: [] }),
            }
          },
        },
      })

      await backend.createForTest(makeLectic(effort))

      expect(seen?.["output_config"]?.effort).toBe(effort)
      expect(seen?.["thinking"]).toEqual({ type: "adaptive" })
    },
  )
})

describe("Gemini thinking effort", () => {
  test.each(["xhigh", "max"] as const)(
    "rejects unsupported %s rather than silently reducing it",
    async (effort) => {
      let called = false
      const backend = new TestGeminiBackend({
        models: {
          generateContentStream() {
            called = true
          },
        },
      })

      expect(
        backend.createForTest(makeLectic(effort)),
      ).rejects.toThrow(
        `gemini provider does not support thinking_effort '${effort}'`,
      )
      expect(called).toBeFalse()
    },
  )
})
