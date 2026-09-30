import { describe, expect, test } from "bun:test"
import { OpenAIResponsesBackend } from "./openai-responses"
import { LLMProvider } from "../types/provider"
import type { BackendCompletion } from "../types/backend"

class TestResponsesBackend extends OpenAIResponsesBackend {
  constructor(
    private readonly fakeClientValue: unknown,
    provider: LLMProvider
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
      lectic: {
        header: {
          interlocutor: {
            name: "Assistant",
            prompt: "Be helpful.",
            model: "gpt-test",
            registry: {},
            tools: [],
          },
        },
      } as any,
    })
  }
}

type FakeStreamOptions = {
  events: unknown[]
  error?: Error
  finalError?: Error
  response?: Record<string, unknown>
}

function fakeStream(options: FakeStreamOptions) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const event of options.events) yield event
      if (options.error) throw options.error
    },
    finalResponse() {
      const error = options.finalError ?? options.error
      return error
        ? Promise.reject(error)
        : Promise.resolve(options.response ?? { output: [] })
    },
  }
}

function testBackend(provider: LLMProvider, streams: FakeStreamOptions[]) {
  const requestInputs: unknown[][] = []
  const backend = new TestResponsesBackend({
    responses: {
      stream(args: Record<string, unknown>) {
        const options = streams[requestInputs.length]
        requestInputs.push([...(args["input"] as unknown[])])
        if (!options) throw new Error("Unexpected extra request")
        return fakeStream(options)
      },
    },
  }, provider)
  return { backend, requestInputs }
}

function textDelta(delta: string, output_index = 0) {
  return { type: "response.output_text.delta", delta, output_index }
}

function messageDone(
  text: string,
  output_index = 0,
  status: "completed" | "incomplete" = "completed"
) {
  return {
    type: "response.output_item.done",
    output_index,
    item: {
      type: "message" as const,
      id: `msg_${output_index}`,
      status,
      role: "assistant" as const,
      content: [
        {
          type: "output_text" as const,
          text,
          annotations: [],
          logprobs: [],
        },
      ],
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

async function expectInterrupted(
  completion: BackendCompletion<any>,
  error: Error,
  expectedText: string
) {
  let visibleText = ""
  const text = (async () => {
    for await (const chunk of completion.chunks) {
      if (chunk.kind === "text") visibleText += chunk.text
    }
  })()
  expect(text).rejects.toBe(error)
  expect(completion.final).rejects.toBe(error)
  await Promise.allSettled([text, completion.final])
  expect(visibleText).toBe(expectedText)
}

describe.each([LLMProvider.Codex, LLMProvider.OpenAIResponses])(
  "Responses WebSocket stream retries (%s)",
  (provider) => {
    const closed = new Error(
      "WebSocket closed before response.completed (code 1012)"
    )

    test("retries before any text has streamed", async () => {
      const { backend, requestInputs } = testBackend(provider, [
        { events: [], error: closed },
        { events: [textDelta("hello")] },
      ])
      const completion = await backend.createForTest([])

      expect(await collectText(completion)).toBe("hello")
      expect((await completion.final).output).toEqual([])
      expect(requestInputs).toEqual([[], []])
    })

    test("an empty delta does not prevent retry", async () => {
      const { backend, requestInputs } = testBackend(provider, [
        { events: [textDelta("")], error: closed },
        { events: [textDelta("hello")] },
      ])
      const completion = await backend.createForTest([])

      expect(await collectText(completion)).toBe("hello")
      await completion.final
      expect(requestInputs).toHaveLength(2)
    })

    test.each([
      "WebSocket closed before response.completed (code 1012)",
      "WebSocket stream error",
      "Idle timeout waiting for WebSocket",
      "Idle timeout sending WebSocket",
    ])("stops on interrupted text: %s", async (message) => {
      const error = new Error(message)
      const { backend, requestInputs } = testBackend(provider, [
        { events: [textDelta("hel")], error },
        { events: [textDelta("a different answer")] },
      ])
      const completion = await backend.createForTest([])

      await expectInterrupted(completion, error, "hel")
      expect(requestInputs).toHaveLength(1)
    })

    test("stops if a retry streams text and then disconnects", async () => {
      const { backend, requestInputs } = testBackend(provider, [
        { events: [], error: closed },
        { events: [textDelta("hel")], error: closed },
        { events: [textDelta("hello")] },
      ])
      const completion = await backend.createForTest([])

      await expectInterrupted(completion, closed, "hel")
      expect(requestInputs).toHaveLength(2)
    })

    test("retries with a completed message in context", async () => {
      const done = messageDone("First.")
      const { backend, requestInputs } = testBackend(provider, [
        { events: [textDelta("First."), done], error: closed },
        { events: [textDelta(" Second.")] },
      ])
      const user = { role: "user", content: "Continue." }
      const completion = await backend.createForTest([user])

      expect(await collectText(completion)).toBe("First. Second.")
      await completion.final
      expect(requestInputs).toEqual([[user], [user, done.item]])
    })

    test("stops if a later message is interrupted", async () => {
      const { backend, requestInputs } = testBackend(provider, [
        {
          events: [
            textDelta("First."),
            messageDone("First."),
            textDelta(" Sec", 1),
          ],
          error: closed,
        },
      ])
      const messages: unknown[] = []
      const completion = await backend.createForTest(messages)

      await expectInterrupted(completion, closed, "First. Sec")
      expect(requestInputs).toHaveLength(1)
      expect(messages).toEqual([])
    })

    test("another item's completion cannot clear partial text", async () => {
      const { backend, requestInputs } = testBackend(provider, [
        {
          events: [
            textDelta("First."),
            textDelta(" Sec", 1),
            messageDone("First."),
          ],
          error: closed,
        },
      ])
      const completion = await backend.createForTest([])

      await expectInterrupted(completion, closed, "First. Sec")
      expect(requestInputs).toHaveLength(1)
    })

    test("an incomplete done item does not permit retry", async () => {
      const { backend, requestInputs } = testBackend(provider, [
        {
          events: [textDelta("hel"), messageDone("hel", 0, "incomplete")],
          error: closed,
        },
      ])
      const completion = await backend.createForTest([])

      await expectInterrupted(completion, closed, "hel")
      expect(requestInputs).toHaveLength(1)
    })

    test("retains completed reasoning when retrying", async () => {
      const reasoning = {
        type: "reasoning",
        id: "rs_1",
        status: "completed",
        summary: [{ type: "summary_text", text: "Thinking." }],
      }
      const { backend, requestInputs } = testBackend(provider, [
        {
          events: [{
            type: "response.output_item.done",
            output_index: 0,
            item: reasoning,
          }],
          error: closed,
        },
        { events: [textDelta("hello")] },
      ])
      const completion = await backend.createForTest([])
      const chunks = []
      for await (const chunk of completion.chunks) chunks.push(chunk)
      await completion.final

      expect(chunks.map((chunk) => chunk.kind)).toEqual(["thought", "text"])
      expect(requestInputs).toEqual([[], [reasoning]])
    })

    test("preserves completed-snapshot recovery", async () => {
      const done = messageDone("hello")
      const { backend, requestInputs } = testBackend(provider, [
        {
          events: [
            textDelta("hello"),
            done,
            { type: "response.completed", response: {} },
          ],
          finalError: new Error("SDK parser error: missing output"),
        },
      ])
      const completion = await backend.createForTest([])

      expect(await collectText(completion)).toBe("hello")
      expect((await completion.final).output).toEqual([{
        ...done.item,
        content: done.item.content.map((part) => ({ ...part, parsed: null })),
      }])
      expect(requestInputs).toHaveLength(1)
    })

    test("keeps the retry budget and final fallback attempt", async () => {
      const { backend, requestInputs } = testBackend(provider, [
        ...Array.from({ length: 6 }, () => ({ events: [], error: closed })),
        { events: [textDelta("hello")] },
      ])
      const completion = await backend.createForTest([])

      expect(await collectText(completion)).toBe("hello")
      await completion.final
      expect(requestInputs).toHaveLength(7)
    })

    test("stops when the retry budget is exhausted", async () => {
      const { backend, requestInputs } = testBackend(provider,
        Array.from({ length: 7 }, () => ({ events: [], error: closed }))
      )
      const completion = await backend.createForTest([])

      await expectInterrupted(completion, closed, "")
      expect(requestInputs).toHaveLength(7)
    })

    test("does not retry non-transport errors", async () => {
      const error = new Error("400 invalid request")
      const { backend, requestInputs } = testBackend(provider, [
        { events: [], error },
      ])
      const completion = await backend.createForTest([])

      await expectInterrupted(completion, error, "")
      expect(requestInputs).toHaveLength(1)
    })
  }
)
