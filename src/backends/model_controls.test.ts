import { describe, expect, test } from "bun:test"
import { OpenAIBackend } from "./openai"
import { OpenAIResponsesBackend } from "./openai-responses"
import { AnthropicBackend } from "./anthropic"
import { GeminiBackend } from "./gemini"
import { LLMProvider } from "../types/provider"
import type { ServiceTier } from "../types/serviceTier"
import type { Verbosity } from "../types/verbosity"

class TestChatBackend extends OpenAIBackend {
  constructor(
    private readonly fakeClientValue: unknown,
    provider: LLMProvider,
  ) {
    super({
      apiKeyEnv: "TEST_API_KEY",
      provider,
      defaultModel: "test-model",
    })
  }

  override get client() {
    return this.fakeClientValue as any
  }

  createForTest(lectic: unknown) {
    return this.createCompletion({ messages: [], lectic: lectic as any })
  }
}

class TestResponsesBackend extends OpenAIResponsesBackend {
  constructor(
    private readonly fakeClientValue: unknown,
    provider = LLMProvider.OpenAIResponses,
  ) {
    super({
      apiKeyEnv: "TEST_API_KEY",
      provider,
      defaultModel: "test-model",
    })
  }

  override get client() {
    return this.fakeClientValue as any
  }

  createForTest(lectic: unknown) {
    return this.createCompletion({ messages: [], lectic: lectic as any })
  }
}

class TestAnthropicBackend extends AnthropicBackend {
  constructor(fakeClient: unknown, provider = LLMProvider.Anthropic) {
    super("test-key")
    this.client = fakeClient as any
    this.provider = provider
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

function makeLectic(control: {
  verbosity?: Verbosity
  service_tier?: ServiceTier
  output_schema?: Record<string, unknown>
}) {
  return {
    header: {
      interlocutor: {
        name: "Assistant",
        prompt: "Be helpful.",
        model: "test-model",
        registry: {},
        tools: [],
        ...control,
      },
    },
  }
}

function emptyChatStream() {
  return {
    async *[Symbol.asyncIterator]() {},
    finalChatCompletion: async () => ({ choices: [{ message: {} }] }),
  }
}

function emptyResponsesStream() {
  return {
    async *[Symbol.asyncIterator]() {},
    finalResponse: async () => ({ output: [] }),
  }
}

function captureChat() {
  let seen: Record<string, unknown> | undefined
  return {
    client: {
      chat: {
        completions: {
          stream(args: Record<string, unknown>) {
            seen = args
            return emptyChatStream()
          },
        },
      },
    },
    seen: () => seen,
  }
}

function captureResponses() {
  let seen: Record<string, unknown> | undefined
  return {
    client: {
      responses: {
        stream(args: Record<string, unknown>) {
          seen = args
          return emptyResponsesStream()
        },
      },
    },
    seen: () => seen,
  }
}

function captureAnthropic() {
  let seen: Record<string, unknown> | undefined
  return {
    client: {
      messages: {
        stream(args: Record<string, unknown>) {
          seen = args
          return { finalMessage: async () => ({ content: [] }) }
        },
      },
    },
    seen: () => seen,
  }
}

function captureGemini() {
  let seen: Record<string, any> | undefined
  return {
    client: {
      models: {
        generateContentStream(args: Record<string, any>) {
          seen = args
          return (async function* () {})()
        },
      },
    },
    seen: () => seen,
  }
}

describe("OpenAI model controls", () => {
  test("maps Chat Completions model controls", async () => {
    const capture = captureChat()
    const backend = new TestChatBackend(
      capture.client,
      LLMProvider.OpenAI,
    )

    await backend.createForTest(makeLectic({
      verbosity: "low",
      service_tier: "standard",
    }))

    expect(capture.seen()?.["verbosity"]).toBe("low")
    expect(capture.seen()?.["service_tier"]).toBe("default")
  })

  test("forwards controls to OpenRouter's compatible API", async () => {
    const capture = captureChat()
    const backend = new TestChatBackend(
      capture.client,
      LLMProvider.OpenRouter,
    )

    await backend.createForTest(makeLectic({
      verbosity: "high",
      service_tier: "priority",
    }))

    expect(capture.seen()?.["verbosity"]).toBe("high")
    expect(capture.seen()?.["service_tier"]).toBe("priority")
  })

  test("rejects controls for Ollama before making a request", () => {
    let called = false
    const backend = new TestChatBackend({
      chat: {
        completions: {
          stream() {
            called = true
            return emptyChatStream()
          },
        },
      },
    }, LLMProvider.Ollama)

    expect(backend.createForTest(makeLectic({ verbosity: "low" })))
      .rejects.toThrow("ollama provider does not support verbosity")
    expect(backend.createForTest(makeLectic({ service_tier: "auto" })))
      .rejects.toThrow("ollama provider does not support service_tier")
    expect(called).toBeFalse()
  })

  test("maps Codex service tier request values", async () => {
    const capture = captureResponses()
    const backend = new TestResponsesBackend(
      capture.client,
      LLMProvider.Codex,
    )

    await backend.createForTest(makeLectic({ service_tier: "auto" }))
    expect(capture.seen()?.["service_tier"]).toBeUndefined()

    await backend.createForTest(makeLectic({ service_tier: "standard" }))
    expect(capture.seen()?.["service_tier"]).toBe("default")

    await backend.createForTest(makeLectic({ service_tier: "priority" }))
    expect(capture.seen()?.["service_tier"]).toBe("priority")
  })

  test("merges Responses verbosity with structured output", async () => {
    const capture = captureResponses()
    const backend = new TestResponsesBackend(capture.client)

    await backend.createForTest(makeLectic({
      verbosity: "high",
      service_tier: "standard",
      output_schema: {
        type: "object",
        properties: { answer: { type: "string" } },
        required: ["answer"],
        additionalProperties: false,
      },
    }))

    expect(capture.seen()?.["text"]).toEqual({
      verbosity: "high",
      format: {
        type: "json_schema",
        name: "output",
        strict: true,
        schema: {
          type: "object",
          properties: { answer: { type: "string" } },
          required: ["answer"],
          additionalProperties: false,
        },
      },
    })
    expect(capture.seen()?.["service_tier"]).toBe("default")
  })
})

describe("Anthropic model controls", () => {
  test.each([
    ["auto", "auto"],
    ["priority", "auto"],
    ["default", "standard_only"],
    ["standard", "standard_only"],
  ] as const)("maps %s service tier to %s", async (requested, expected) => {
    const capture = captureAnthropic()
    const backend = new TestAnthropicBackend(capture.client)

    await backend.createForTest(makeLectic({ service_tier: requested }))

    expect(capture.seen()?.["service_tier"]).toBe(expected)
  })

  test("rejects flex tier rather than silently changing it", () => {
    const capture = captureAnthropic()
    const backend = new TestAnthropicBackend(capture.client)

    expect(backend.createForTest(makeLectic({ service_tier: "flex" })))
      .rejects.toThrow(
        "anthropic provider does not support service_tier 'flex'",
      )
    expect(capture.seen()).toBeUndefined()
  })

  test("rejects verbosity", () => {
    const capture = captureAnthropic()
    const backend = new TestAnthropicBackend(capture.client)

    expect(backend.createForTest(makeLectic({ verbosity: "medium" })))
      .rejects.toThrow("anthropic provider does not support verbosity")
    expect(capture.seen()).toBeUndefined()
  })

  test("rejects service tiers through Bedrock", () => {
    const capture = captureAnthropic()
    const backend = new TestAnthropicBackend(
      capture.client,
      LLMProvider.AnthropicBedrock,
    )

    expect(backend.createForTest(makeLectic({ service_tier: "auto" })))
      .rejects.toThrow(
        "anthropic/bedrock provider does not support service_tier",
      )
    expect(capture.seen()).toBeUndefined()
  })
})

describe("Gemini model controls", () => {
  test.each([
    ["auto", "unspecified"],
    ["default", "unspecified"],
    ["standard", "standard"],
    ["flex", "flex"],
    ["priority", "priority"],
  ] as const)("maps %s service tier to %s", async (requested, expected) => {
    const capture = captureGemini()
    const backend = new TestGeminiBackend(capture.client)

    await backend.createForTest(makeLectic({ service_tier: requested }))

    expect(capture.seen()?.["config"]?.serviceTier).toBe(expected)
  })

  test("rejects verbosity", () => {
    const capture = captureGemini()
    const backend = new TestGeminiBackend(capture.client)

    expect(backend.createForTest(makeLectic({ verbosity: "high" })))
      .rejects.toThrow("gemini provider does not support verbosity")
    expect(capture.seen()).toBeUndefined()
  })
})
