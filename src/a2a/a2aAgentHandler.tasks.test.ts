import { describe, expect, test } from "bun:test"

import type { AgentCard, MessageSendParams, Task } from "@a2a-js/sdk"

import { A2AAgentHandler } from "./a2aAgentHandler"
import type { PersistedAgentRuntime } from "../agents/persistedRuntime"

function mkCard(): AgentCard {
  return {
    name: "TestAgent",
    description: "test",
    protocolVersion: "0.3.0",
    version: "0.0.0",
    preferredTransport: "JSONRPC",
    url: "http://127.0.0.1/agents/test/a2a/jsonrpc",
    capabilities: { streaming: true, pushNotifications: false },
    defaultInputModes: ["text"],
    defaultOutputModes: ["text"],
    skills: [],
  }
}

function mkSendParams(opt: {
  text: string
  contextId?: string
  taskId?: string
}): MessageSendParams {
  return {
    message: {
      kind: "message",
      role: "user",
      messageId: crypto.randomUUID(),
      contextId: opt.contextId,
      taskId: opt.taskId,
      parts: [{ kind: "text", text: opt.text }],
    },
  }
}

async function waitForTerminal(
  handler: A2AAgentHandler,
  taskId: string
): Promise<Task> {
  for (let i = 0; i < 200; i++) {
    const task = await handler.getTask({ id: taskId } as never)

    if (task.status.state === "completed" || task.status.state === "failed") {
      return task
    }

    await new Promise((r) => setTimeout(r, 5))
  }

  throw new Error(`Timed out waiting for terminal state: ${taskId}`)
}

describe("A2AAgentHandler task support", () => {
  test("sendMessageStream yields state transitions (no artifact text)", async () => {
    const runtime = {
      interlocutorName: "Agent",
      runBlockingTurnRaw: async () => "hello\n",
    } as unknown as PersistedAgentRuntime

    const handler = new A2AAgentHandler({
      runtime,
      card: mkCard(),
      fastPathMs: 0,
    })

    const events: Array<{ kind: string }> = []

    for await (const ev of handler.sendMessageStream(mkSendParams({ text: "hi" }))) {
      events.push(ev as { kind: string })
    }

    expect(events.map((e) => e.kind)).toEqual([
      "task",
      "status-update",
      "status-update",
    ])

    const task = events[0] as unknown as Task
    expect(task.status.state).toBe("submitted")

    const working = events[1] as unknown as {
      status: { state: string }
      final: boolean
    }

    expect(working.status.state).toBe("working")
    expect(working.final).toBe(false)

    const done = events[2] as unknown as {
      status: { state: string }
      final: boolean
    }

    expect(done.status.state).toBe("completed")
    expect(done.final).toBe(true)
  })

  test("message/send fast path returns Message and task is still stored", async () => {
    const runtime = {
      interlocutorName: "Agent",
      runBlockingTurnRaw: async () => "final\n",
    } as unknown as PersistedAgentRuntime

    const handler = new A2AAgentHandler({
      runtime,
      card: mkCard(),
      fastPathMs: 10_000,
    })

    const res = await handler.sendMessage(mkSendParams({ text: "hi" }))

    if (res.kind !== "message" || !res.taskId) {
      throw new Error(`Expected message with taskId, got: ${res.kind}`)
    }

    const task = await handler.getTask({ id: res.taskId } as never)

    expect(task.status.state).toBe("completed")
    expect(task.status.message?.kind).toBe("message")
    expect(task.status.message?.parts?.[0]?.kind).toBe("text")

    const firstPart = task.status.message?.parts?.[0] as { text?: string }
    expect(firstPart.text).toBe("final")
  })

  test("tasks are queued FIFO per contextId", async () => {
    const calls: string[] = []

    const runtime = {
      interlocutorName: "Agent",
      runBlockingTurnRaw: async (args: { contextId: string; userText: string }) => {
        calls.push(args.userText)
        await new Promise((r) => setTimeout(r, 20))
        return `reply:${args.userText}`
      },
    } as unknown as PersistedAgentRuntime

    const handler = new A2AAgentHandler({
      runtime,
      card: mkCard(),
      fastPathMs: 0,
    })

    const t1 = (await handler.sendMessage(
      mkSendParams({ text: "one", contextId: "c" })
    )) as Task

    const t2 = (await handler.sendMessage(
      mkSendParams({ text: "two", contextId: "c" })
    )) as Task

    await waitForTerminal(handler, t1.id)
    await waitForTerminal(handler, t2.id)

    expect(calls).toEqual(["one", "two"])
  })

  test("GC trims old terminal tasks per context", async () => {
    const runtime = {
      interlocutorName: "Agent",
      runBlockingTurnRaw: async (args: { userText: string }) => {
        await new Promise((r) => setTimeout(r, 5))
        return `reply:${args.userText}`
      },
    } as unknown as PersistedAgentRuntime

    const handler = new A2AAgentHandler({
      runtime,
      card: mkCard(),
      fastPathMs: 0,
      maxTasksPerContext: 2,
    })

    const t1 = (await handler.sendMessage(
      mkSendParams({ text: "1", contextId: "c" })
    )) as Task

    const t2 = (await handler.sendMessage(
      mkSendParams({ text: "2", contextId: "c" })
    )) as Task

    const t3 = (await handler.sendMessage(
      mkSendParams({ text: "3", contextId: "c" })
    )) as Task

    // Waiting for the most recent task is enough: tasks run FIFO per
    // contextId, so by the time t3 is terminal, t1 and t2 have finished.
    await waitForTerminal(handler, t3.id)

    let t1Error: unknown

    try {
      await handler.getTask({ id: t1.id } as never)
    } catch (e) {
      t1Error = e
    }

    expect(t1Error).toBeDefined()

    const got2 = await handler.getTask({ id: t2.id } as never)
    const got3 = await handler.getTask({ id: t3.id } as never)

    expect(got2.id).toBe(t2.id)
    expect(got3.id).toBe(t3.id)
  })

  test("client-supplied unknown taskId is rejected", async () => {
    const runtime = {
      interlocutorName: "Agent",
      runBlockingTurnRaw: async () => "ok",
    } as unknown as PersistedAgentRuntime

    const handler = new A2AAgentHandler({
      runtime,
      card: mkCard(),
      fastPathMs: 0,
    })

    let err: unknown

    try {
      await handler.sendMessage(mkSendParams({ text: "hi", taskId: "nope" }))
    } catch (e) {
      err = e
    }

    expect(err).toBeDefined()
  })

  test("client-supplied existing taskId is also rejected", async () => {
    const runtime = {
      interlocutorName: "Agent",
      runBlockingTurnRaw: async () => "ok",
    } as unknown as PersistedAgentRuntime

    const handler = new A2AAgentHandler({
      runtime,
      card: mkCard(),
      fastPathMs: 0,
    })

    const t1 = (await handler.sendMessage(mkSendParams({ text: "hi" }))) as Task
    await waitForTerminal(handler, t1.id)

    let err: unknown

    try {
      await handler.sendMessage(mkSendParams({ text: "again", taskId: t1.id }))
    } catch (e) {
      err = e
    }

    expect(err).toBeDefined()
  })

  test("failed tasks show failed state and an error message", async () => {
    const runtime = {
      interlocutorName: "Agent",
      runBlockingTurnRaw: async () => {
        throw new Error("boom")
      },
    } as unknown as PersistedAgentRuntime

    const handler = new A2AAgentHandler({
      runtime,
      card: mkCard(),
      fastPathMs: 0,
    })

    const t1 = (await handler.sendMessage(mkSendParams({ text: "hi" }))) as Task
    const terminal = await waitForTerminal(handler, t1.id)

    expect(terminal.status.state).toBe("failed")
    expect(terminal.status.message?.kind).toBe("message")

    const part = terminal.status.message?.parts?.[0] as { text?: string }
    expect(part.text).toContain("Task failed")
    expect(part.text).toContain("boom")
  })

  test("tasks/get rejects missing id", async () => {
    const runtime = {
      interlocutorName: "Agent",
      runBlockingTurnRaw: async () => "ok",
    } as unknown as PersistedAgentRuntime

    const handler = new A2AAgentHandler({
      runtime,
      card: mkCard(),
      fastPathMs: 0,
    })

    let err: unknown

    try {
      await handler.getTask({} as never)
    } catch (e) {
      err = e
    }

    expect(err).toBeDefined()
  })
})
