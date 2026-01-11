import { describe, expect, it } from "bun:test"
import { Backend, type BackendCompletion, type ToolCallEntry, type ToolRegistry } from "./backend"
import { LLMProvider } from "./provider"
import type { Message } from "./message"
import { UserMessage } from "./message"
import { Lectic, LecticBody, LecticHeader, type HasModel } from "./lectic"
import type { InlineAttachment } from "./inlineAttachment"
import type { ToolCall } from "./tool"

class DummyBackend extends Backend<unknown, Record<string, never>> {
  provider = LLMProvider.OpenAI
  defaultModel = "dummy"

  seenUserContent: string[] = []

  async listModels(): Promise<string[]> {
    return []
  }

  protected async handleMessage(
    msg: Message,
    _lectic: Lectic,
    _opt?: { inlineAttachments?: InlineAttachment[] }
  ): Promise<{ messages: unknown[]; reset: boolean }> {
    if (msg.role === "user") this.seenUserContent.push(msg.content)
    return { messages: [], reset: false }
  }

  protected async createCompletion(_opt: {
    messages: unknown[]
    lectic: Lectic & HasModel
  }): Promise<BackendCompletion<Record<string, never>>> {
    return {
      text: (async function* (): AsyncGenerator<string> {})(),
      final: Promise.resolve({}),
    }
  }

  protected finalHasToolCalls(_final: Record<string, never>): boolean {
    return false
  }

  protected finalUsage(_final: Record<string, never>): undefined {
    return undefined
  }

  protected applyReset(
    _messages: unknown[],
    _resetAttachments: InlineAttachment[],
  ): void {
    // no-op
  }

  protected appendAssistantMessage(
    _messages: unknown[],
    _final: Record<string, never>,
    _lectic: Lectic
  ): void {
    // no-op
  }

  protected getToolCallEntries(
    _final: Record<string, never>,
    _registry: ToolRegistry
  ): ToolCallEntry[] {
    return []
  }

  protected async appendToolResults(_opt: {
    messages: unknown[]
    final: Record<string, never>
    realized: ToolCall[]
    hookAttachments: InlineAttachment[]
    lectic: Lectic
  }): Promise<void> {
    // no-op
  }
}

describe("Backend.evaluate", () => {
  it("strips built-in directives from provider-visible user messages", async () => {
    const backend = new DummyBackend()

    const header = new LecticHeader({
      interlocutor: {
        name: "Assistant",
        prompt: "test",
      },
    } as any)

    // Avoid needing initialize() in this unit test.
    header.interlocutor.registry = {}

    const msg = new UserMessage({
      content:
        'Hello :cmd[echo one] :merge_yaml[{ interlocutor: { model: "x" } }]',
    })

    const body = new LecticBody({ messages: [msg], raw: "" })
    const lectic = new Lectic({ header, body })

    for await (const _chunk of backend.evaluate(lectic)) {
      // drain
    }

    expect(backend.seenUserContent).toHaveLength(1)
    expect(backend.seenUserContent[0]).not.toContain(":cmd[")
    expect(backend.seenUserContent[0]).not.toContain(":merge_yaml[")

    // The original transcript message should remain unchanged.
    expect(msg.content).toContain(":cmd[")
    expect(msg.content).toContain(":merge_yaml[")
  })
})
