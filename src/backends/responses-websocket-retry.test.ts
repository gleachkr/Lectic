import { describe, expect, test } from "bun:test"
import { OpenAIResponsesBackend } from "./openai-responses"
import { LLMProvider } from "../types/provider"
import type { BackendCompletion } from "../types/backend"

class TestResponsesBackend extends OpenAIResponsesBackend {
  constructor(
    private readonly fakeClientValue: unknown,
    provider = LLMProvider.OpenAIResponses
  ) {
    super({
      apiKeyEnv: "OPENAI_API_KEY",
      provider,
      defaultModel: "gpt-test",
    })
  }

  override get client() {
    return this.fakeClientValue as any
  }

  protected override webSocketStreamRetryDelay(): number {
    return 0
  }

  createForTest(messages: unknown[]) {
    return this.createCompletion({
      messages: messages as any,
      lectic: makeLectic() as any,
    })
  }
}

function makeLectic() {
  return {
    header: {
      interlocutor: {
        name: "Assistant",
        prompt: "Be helpful.",
        model: "gpt-test",
        registry: {},
        tools: [],
      },
    },
  }
}

type FakeStreamOptions = {
  events: unknown[]
  error?: Error
  response?: Record<string, unknown>
}

function fakeStream(options: FakeStreamOptions) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const event of options.events) yield event
      if (options.error) throw options.error
    },
    finalResponse() {
      return options.error
        ? Promise.reject(options.error)
        : Promise.resolve(options.response ?? { output: [] })
    },
  }
}

async function collectText(
  completion: BackendCompletion<any>
): Promise<string> {
  let text = ""
  for await (const chunk of completion.chunks) {
    if (chunk.kind === "text") text += chunk.text
  }
  return text
}

describe("Responses WebSocket stream retries", () => {
  test("retries a 1012 close for a non-Codex backend", async () => {
    const closed = new Error(
      "WebSocket closed before response.completed (code 1012)"
    )
    const streams = [
      fakeStream({
        events: [
          { type: "response.output_text.delta", delta: "hel" },
        ],
        error: closed,
      }),
      fakeStream({
        events: [
          { type: "response.output_text.delta", delta: "hello" },
        ],
        response: { output: [] },
      }),
    ]
    let requests = 0
    const backend = new TestResponsesBackend({
      responses: {
        stream() {
          return streams[requests++]
        },
      },
    })

    const completion = await backend.createForTest([])

    expect(await collectText(completion)).toBe("hello")
    const final = await completion.final
    expect(final.output).toEqual([])
    expect(requests).toBe(2)
  })

  test("includes completed items in the retried request context", async () => {
    const closed = new Error(
      "WebSocket closed before response.completed (code 1012)"
    )
    const completedMessage = {
      type: "message",
      id: "msg_1",
      status: "completed",
      role: "assistant",
      content: [
        {
          type: "output_text",
          text: "First.",
          annotations: [],
          logprobs: [],
        },
      ],
    }
    const streams = [
      fakeStream({
        events: [
          { type: "response.output_text.delta", delta: "First." },
          {
            type: "response.output_item.done",
            output_index: 0,
            item: completedMessage,
          },
        ],
        error: closed,
      }),
      fakeStream({
        events: [
          { type: "response.output_text.delta", delta: " Second." },
        ],
        response: { output: [] },
      }),
    ]
    const requestInputs: unknown[] = []
    let requests = 0
    const backend = new TestResponsesBackend({
      responses: {
        stream(args: Record<string, unknown>) {
          requestInputs.push([...(args["input"] as unknown[])])
          return streams[requests++]
        },
      },
    })

    const completion = await backend.createForTest([
      { role: "user", content: "Continue." },
    ])

    expect(await collectText(completion)).toBe("First. Second.")
    await completion.final
    expect(requestInputs).toHaveLength(2)
    expect(requestInputs[1]).toContainEqual(completedMessage)
  })

  test("fails when retried text diverges", async () => {
    const closed = new Error(
      "WebSocket closed before response.completed (code 1012)"
    )
    const streams = [
      fakeStream({
        events: [
          { type: "response.output_text.delta", delta: "hel" },
        ],
        error: closed,
      }),
      fakeStream({
        events: [
          { type: "response.output_text.delta", delta: "hey" },
        ],
        response: { output: [] },
      }),
    ]
    let requests = 0
    const backend = new TestResponsesBackend({
      responses: {
        stream() {
          return streams[requests++]
        },
      },
    })

    const completion = await backend.createForTest([])
    const text = collectText(completion)

    expect(text).rejects.toThrow(
      "WebSocket retry text diverged from the partial response"
    )
    expect(completion.final).rejects.toThrow(
      "WebSocket retry text diverged from the partial response"
    )
    await Promise.allSettled([text, completion.final])
    expect(requests).toBe(2)
  })

  test("keeps the original prefix across repeated disconnects", async () => {
    const closed = new Error(
      "WebSocket closed before response.completed (code 1012)"
    )
    const streams = [
      fakeStream({
        events: [
          { type: "response.output_text.delta", delta: "hello" },
        ],
        error: closed,
      }),
      fakeStream({
        events: [
          { type: "response.output_text.delta", delta: "hel" },
        ],
        error: closed,
      }),
      fakeStream({
        events: [
          { type: "response.output_text.delta", delta: "help" },
        ],
        response: { output: [] },
      }),
    ]
    let requests = 0
    const backend = new TestResponsesBackend({
      responses: {
        stream() {
          return streams[requests++]
        },
      },
    })

    const completion = await backend.createForTest([])
    const text = collectText(completion)

    expect(text).rejects.toThrow(
      "WebSocket retry text diverged from the partial response"
    )
    expect(completion.final).rejects.toThrow(
      "WebSocket retry text diverged from the partial response"
    )
    await Promise.allSettled([text, completion.final])
    expect(requests).toBe(3)
  })

  test("fails when a successful retry is shorter", async () => {
    const closed = new Error(
      "WebSocket closed before response.completed (code 1012)"
    )
    const streams = [
      fakeStream({
        events: [
          { type: "response.output_text.delta", delta: "hello" },
        ],
        error: closed,
      }),
      fakeStream({
        events: [
          { type: "response.output_text.delta", delta: "hell" },
        ],
        response: { output: [] },
      }),
    ]
    let requests = 0
    const backend = new TestResponsesBackend({
      responses: {
        stream() {
          return streams[requests++]
        },
      },
    })

    const completion = await backend.createForTest([])
    const text = collectText(completion)

    expect(text).rejects.toThrow(
      "WebSocket retry text diverged from the partial response"
    )
    expect(completion.final).rejects.toThrow(
      "WebSocket retry text diverged from the partial response"
    )
    await Promise.allSettled([text, completion.final])
    expect(requests).toBe(2)
  })

  test("does not retry non-transport errors", async () => {
    const rejected = new Error("400 invalid request")
    let requests = 0
    const backend = new TestResponsesBackend({
      responses: {
        stream() {
          requests++
          return fakeStream({ events: [], error: rejected })
        },
      },
    })

    const completion = await backend.createForTest([])

    expect(collectText(completion)).rejects.toBe(rejected)
    expect(completion.final).rejects.toBe(rejected)
    expect(requests).toBe(1)
  })
})
