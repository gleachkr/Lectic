import { describe, expect, test } from "bun:test"
import OpenAI from "openai"
import { AssistantMessage, UserMessage } from "../types/message"
import type { Message } from "../types/message"
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

  appendForTest(messages: unknown[], output: unknown[]) {
    this.appendAssistantMessage(
      messages as any,
      { output } as any,
      {} as any
    )
  }

  historyForTest(message: Message) {
    return this.handleMessage(message, {
      header: { interlocutor: { name: "Assistant" } },
    } as any)
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

    test.each([
      { content: [] },
      { content: [{ type: "reasoning_text", text: "Saved reasoning." }] },
      { content: null },
    ])("normalizes reasoning content on input: %j", async ({ content }) => {
      const reasoning = {
        type: "reasoning",
        id: "rs_saved",
        status: "completed",
        summary: [{ type: "summary_text", text: "Thinking." }],
        encrypted_content: "opaque-state",
        content,
      }
      const {
        content: _content, status: _status, ...codexReasoning
      } = reasoning
      const user = {
        role: "user",
        content: [{ type: "input_text", text: "Continue." }],
      }
      const assistant = messageDone("Earlier answer.").item
      const call = {
        type: "function_call",
        call_id: "call_1",
        name: "test_tool",
        arguments: "{}",
      }
      const result = {
        type: "function_call_output",
        call_id: "call_1",
        output: "result",
      }
      const messages = [user, reasoning, assistant, call, result]
      const original = structuredClone(messages)
      const { backend, requestInputs } = testBackend(provider, [
        { events: [] },
      ])
      const completion = await backend.createForTest(messages)
      await collectText(completion)
      await completion.final

      expect(requestInputs).toEqual([[
        provider === LLMProvider.Codex ? { ...user, type: "message" } : user,
        provider === LLMProvider.Codex ? codexReasoning : reasoning,
        assistant,
        call,
        result,
      ]])
      expect(messages).toEqual(original)
    })

    test.each(["user", "assistant", "system", "developer"])(
      "normalizes shorthand %s messages",
      async (role) => {
        const messages = [{ role, content: "Saved text." }]
        const original = structuredClone(messages)
        const { backend, requestInputs } = testBackend(provider, [
          { events: [] },
        ])
        const completion = await backend.createForTest(messages)
        await collectText(completion)
        await completion.final

        expect(requestInputs).toEqual([provider === LLMProvider.Codex
          ? [{
              type: "message",
              role,
              content: [role === "assistant"
                ? {
                    type: "output_text",
                    text: "Saved text.",
                    annotations: [],
                  }
                : { type: "input_text", text: "Saved text." }],
            }]
          : messages])
        expect(messages).toEqual(original)
      }
    )

    test("normalizes actual saved history", async () => {
      const { backend, requestInputs } = testBackend(provider, [
        { events: [] },
      ])
      const user = await backend.historyForTest(new UserMessage({
        content: "Continue.",
      }))
      const assistant = await backend.historyForTest(new AssistantMessage({
        content: "Earlier answer.",
        interlocutor: { name: "Assistant" } as any,
      }))
      const messages = [...assistant.messages, ...user.messages]
      const original = structuredClone(messages)
      const completion = await backend.createForTest(messages)
      await collectText(completion)
      await completion.final

      expect(requestInputs).toEqual([provider === LLMProvider.Codex
        ? [
            {
              type: "message",
              role: "assistant",
              content: [{
                type: "output_text",
                text: "Earlier answer.",
                annotations: [],
              }],
            },
            {
              type: "message",
              role: "user",
              content: [{ type: "input_text", text: "Continue." }],
            },
          ]
        : messages])
      expect(messages).toEqual(original)
    })

    test("preserves media and strips parsed assistant content", async () => {
      const user = {
        role: "user",
        content: [
          { type: "input_text", text: "Inspect this." },
          {
            type: "input_image",
            image_url: "data:image/png;base64,AQ==",
            detail: "auto",
          },
          {
            type: "input_file",
            filename: "document.pdf",
            file_data: "data:application/pdf;base64,AQ==",
          },
        ],
      }
      const annotations = [{
        type: "url_citation",
        start_index: 0,
        end_index: 6,
        title: "Source",
        url: "https://example.com",
      }]
      const part = {
        type: "output_text",
        text: "Answer.",
        annotations,
        logprobs: [],
        parsed: { answer: "Answer." },
      }
      const assistant = {
        ...messageDone("Answer.").item,
        phase: "commentary",
        encrypted_content: "opaque-message",
        content: [part],
      }
      const { parsed: _parsed, ...codexPart } = part
      const messages = [user, assistant]
      const original = structuredClone(messages)
      const { backend, requestInputs } = testBackend(provider, [
        { events: [] },
      ])
      const completion = await backend.createForTest(messages)
      await collectText(completion)
      await completion.final

      expect(requestInputs).toEqual([provider === LLMProvider.Codex
        ? [
            { ...user, type: "message" },
            { ...assistant, content: [codexPart] },
          ]
        : messages])
      expect(messages).toEqual(original)
    })

    test("normalizes SDK output replayed after a tool call", async () => {
      const assistant = {
        ...messageDone("Inspecting.").item,
        phase: "commentary",
        content: [{
          ...messageDone("Inspecting.").item.content[0],
          parsed: null,
        }],
      }
      const call = {
        type: "function_call",
        id: "fc_1",
        call_id: "call_1",
        name: "read_text_file",
        arguments: "{}",
        parsed_arguments: {},
      }
      const { parsed_arguments: _args, ...inputCall } = call
      const { parsed: _parsed, ...inputPart } = assistant.content[0]
      const output = [assistant, call]
      const original = structuredClone(output)
      const result = {
        type: "function_call_output",
        call_id: "call_1",
        output: "File contents.",
      }
      const { backend, requestInputs } = testBackend(provider, [
        { events: [] },
      ])
      const messages: unknown[] = []
      backend.appendForTest(messages, output)
      messages.push(result)
      const completion = await backend.createForTest(messages)
      await collectText(completion)
      await completion.final

      expect(requestInputs).toEqual([[
        provider === LLMProvider.Codex
          ? { ...assistant, content: [inputPart] }
          : assistant,
        inputCall,
        result,
      ]])
      expect(output).toEqual(original)
    })

    test("normalizes reasoning replayed after a tool call", async () => {
      const reasoning = {
        type: "reasoning",
        id: "rs_tool",
        status: "completed",
        summary: [],
        content: [],
        encrypted_content: "opaque-state",
      }
      const {
        content: _content, status: _status, ...codexReasoning
      } = reasoning
      const call = {
        type: "function_call",
        call_id: "call_1",
        name: "test_tool",
        arguments: "{}",
      }
      const output = [reasoning, call]
      const { backend, requestInputs } = testBackend(provider, [
        { events: [] },
      ])
      const messages: unknown[] = []
      backend.appendForTest(messages, output)
      const completion = await backend.createForTest(messages)
      await collectText(completion)
      await completion.final

      expect(requestInputs).toEqual([[
        provider === LLMProvider.Codex ? codexReasoning : reasoning,
        call,
      ]])
      expect(reasoning.content).toEqual([])
      expect(messages).toEqual(output)
    })

    test("serializes clean replay through the real SDK", async () => {
      const assistant = {
        ...messageDone("Inspecting.").item,
        phase: "commentary",
      }
      const call = {
        type: "function_call",
        id: "fc_1",
        status: "completed",
        call_id: "call_1",
        name: "read_text_file",
        arguments: "{}",
      }
      const output = [assistant, call]
      const user = { role: "user", content: "Inspect this file." }
      const result = {
        type: "function_call_output",
        call_id: "call_1",
        output: "File contents.",
      }
      const wireInputs: unknown[] = []
      const client = new OpenAI({
        apiKey: "offline-test",
        fetch: async (_input, init) => {
          const body = JSON.parse(String(init?.body))
          wireInputs.push(body.input)
          const response = {
            id: `resp_${wireInputs.length}`,
            object: "response",
            status: "completed",
            output: wireInputs.length === 1 ? output : [],
          }
          const events = [
            {
              type: "response.created",
              response: { ...response, status: "in_progress", output: [] },
            },
            { type: "response.completed", response },
          ]
          return new Response(events.map((event) =>
            `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`
          ).join(""), {
            headers: { "content-type": "text/event-stream" },
          })
        },
      })
      const backend = new TestResponsesBackend(client, provider)
      const messages: unknown[] = [user]
      const first = await backend.createForTest(messages)
      await collectText(first)
      const final = await first.final
      const original = structuredClone(final.output)
      expect(final.output[0]).toMatchObject({
        content: [{ parsed: null }],
      })
      expect(final.output[1]).toMatchObject({ parsed_arguments: null })
      backend.appendForTest(messages, final.output)
      messages.push(result)
      const second = await backend.createForTest(messages)
      await collectText(second)
      await second.final

      const inputUser = provider === LLMProvider.Codex
        ? {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: user.content }],
          }
        : user
      expect(wireInputs).toEqual([
        [inputUser],
        [
          inputUser,
          provider === LLMProvider.Codex ? assistant : original[0],
          call,
          result,
        ],
      ])
      expect(final.output).toEqual(original)
    })

    test("strips parsed function arguments at request time", async () => {
      const call = {
        type: "function_call",
        call_id: "call_1",
        name: "read_text_file",
        arguments: "{}",
        parsed_arguments: {},
      }
      const { parsed_arguments: _parsed, ...inputCall } = call
      const reference = { id: "msg_1" }
      const messages = [call, reference]
      const original = structuredClone(messages)
      const { backend, requestInputs } = testBackend(provider, [
        { events: [] },
      ])
      const completion = await backend.createForTest(messages)
      await collectText(completion)
      await completion.final

      expect(requestInputs).toEqual([[
        provider === LLMProvider.Codex ? inputCall : call,
        reference,
      ]])
      expect(messages).toEqual(original)
    })

    test("cleans completed SDK text at retry boundaries", async () => {
      const done = messageDone("Finished commentary.")
      const part = { ...done.item.content[0], parsed: null }
      const assistant = { ...done.item, content: [part] }
      const { parsed: _parsed, ...inputPart } = part
      const { backend, requestInputs } = testBackend(provider, [
        {
          events: [
            textDelta("Finished commentary."),
            { ...done, item: assistant },
          ],
          error: closed,
        },
        { events: [textDelta("Answer.")] },
      ])
      const completion = await backend.createForTest([])
      expect(await collectText(completion)).toBe(
        "Finished commentary.Answer."
      )
      await completion.final
      expect(requestInputs).toEqual([[], [provider === LLMProvider.Codex
        ? { ...assistant, content: [inputPart] }
        : assistant]])
      expect(assistant.content[0]).toHaveProperty("parsed", null)
    })

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
      const inputUser = provider === LLMProvider.Codex
        ? {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: user.content }],
          }
        : user
      expect(requestInputs).toEqual([[inputUser], [inputUser, done.item]])
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
        content: [{ type: "reasoning_text", text: "Reasoning output." }],
        encrypted_content: "opaque-state",
      }
      const {
        content: _content, status: _status, ...codexReasoning
      } = reasoning
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
      expect(requestInputs).toEqual([[], [
        provider === LLMProvider.Codex ? codexReasoning : reasoning,
      ]])
      expect(chunks[0]).toMatchObject({
        kind: "thought",
        block: {
          content: ["Reasoning output."],
          opaque: { encrypted_content: "opaque-state" },
        },
      })
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
