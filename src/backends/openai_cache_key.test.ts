import { describe, expect, test } from "bun:test"
import { OpenAIBackend } from "./openai"
import { OpenAIResponsesBackend } from "./openai-responses"
import { LLMProvider } from "../types/provider"

type FakeChatStream = AsyncIterable<never> & {
  finalChatCompletion(): Promise<unknown>
}

type FakeResponsesStream = AsyncIterable<never> & {
  finalResponse(): Promise<unknown>
}

class TestOpenAIBackend extends OpenAIBackend {
  constructor(private readonly fakeClientValue: unknown) {
    super({
      apiKeyEnv: "OPENAI_API_KEY",
      provider: LLMProvider.OpenAI,
      defaultModel: "gpt-5",
    })
  }

  override get client() {
    return this.fakeClientValue as any
  }

  createForTest(messages: unknown[], lectic: unknown) {
    return this.createCompletion({
      messages: messages as any,
      lectic: lectic as any,
    })
  }
}

class TestOpenAIResponsesBackend extends OpenAIResponsesBackend {
  constructor(private readonly fakeClientValue: unknown) {
    super({
      apiKeyEnv: "OPENAI_API_KEY",
      provider: LLMProvider.OpenAIResponses,
      defaultModel: "gpt-5",
    })
  }

  override get client() {
    return this.fakeClientValue as any
  }

  createForTest(messages: unknown[], lectic: unknown) {
    return this.createCompletion({
      messages: messages as any,
      lectic: lectic as any,
    })
  }
}

function makeLectic(id?: string) {
  return {
    header: {
      id,
      interlocutor: {
        name: "Assistant",
        prompt: "Be helpful.",
        model: "gpt-5",
        registry: {},
      },
    },
  }
}

function emptyChatStream(): FakeChatStream {
  return {
    [Symbol.asyncIterator]() {
      return {
        next: async () => ({ done: true, value: undefined as never }),
        [Symbol.asyncIterator]() {
          return this
        },
      } as unknown as AsyncGenerator<never>
    },
    finalChatCompletion() {
      return Promise.resolve({ choices: [{ message: {} }] })
    },
  }
}

function emptyResponsesStream(): FakeResponsesStream {
  return {
    [Symbol.asyncIterator]() {
      return {
        next: async () => ({ done: true, value: undefined as never }),
        [Symbol.asyncIterator]() {
          return this
        },
      } as unknown as AsyncGenerator<never>
    },
    finalResponse() {
      return Promise.resolve({ output: [] })
    },
  }
}

describe("OpenAI prompt_cache_key", () => {
  test("passes top-level id to chat completions requests", async () => {
    let seen: Record<string, unknown> | undefined

    const backend = new TestOpenAIBackend({
      chat: {
        completions: {
          stream(args: Record<string, unknown>) {
            seen = args
            return emptyChatStream()
          },
        },
      },
    })

    await backend.createForTest([], makeLectic("project-cache-key"))

    expect(seen?.["prompt_cache_key"]).toBe("project-cache-key")
  })

  test("passes top-level id to responses requests", async () => {
    let seen: Record<string, unknown> | undefined

    const backend = new TestOpenAIResponsesBackend({
      responses: {
        stream(args: Record<string, unknown>) {
          seen = args
          return emptyResponsesStream()
        },
      },
    })

    await backend.createForTest([], makeLectic("project-cache-key"))

    expect(seen?.["prompt_cache_key"]).toBe("project-cache-key")
  })

  test("leaves prompt_cache_key undefined when config id is absent", async () => {
    let seen: Record<string, unknown> | undefined

    const backend = new TestOpenAIBackend({
      chat: {
        completions: {
          stream(args: Record<string, unknown>) {
            seen = args
            return emptyChatStream()
          },
        },
      },
    })

    await backend.createForTest([], makeLectic())

    expect(seen?.["prompt_cache_key"]).toBeUndefined()
  })
})
