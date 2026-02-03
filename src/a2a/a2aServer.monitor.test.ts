import { describe, expect, test } from "bun:test"

import type { AgentCard, MessageSendParams, Task } from "@a2a-js/sdk"
import { JsonRpcTransportHandler } from "@a2a-js/sdk/server"

import type { PersistedAgentRuntime } from "../agents/persistedRuntime"

import { A2AAgentHandler } from "./a2aAgentHandler"
import { startA2AServer, type A2AServerAgent } from "./a2aServer"

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

function mkSendParams(opt: { text: string; contextId?: string }):
  MessageSendParams {
  return {
    message: {
      kind: "message",
      role: "user",
      messageId: crypto.randomUUID(),
      contextId: opt.contextId,
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

type SseReader = {
  reader: ReadableStreamDefaultReader<Uint8Array>
  dec: TextDecoder
  buf: string
}

function mkSseReader(res: Response): SseReader {
  const body = res.body
  if (!body) throw new Error("missing response body")

  return {
    reader: body.getReader(),
    dec: new TextDecoder(),
    buf: "",
  }
}

async function readNextSseEvent(
  r: SseReader,
  timeoutMs: number,
): Promise<unknown> {
  const deadline = Date.now() + timeoutMs

  while (Date.now() < deadline) {
    const remain = Math.max(0, deadline - Date.now())

    const chunk = await Promise.race([
      r.reader.read(),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), remain)),
    ])

    if (chunk === null) {
      break
    }

    const { value, done } = chunk
    if (done) break

    r.buf += r.dec.decode(value, { stream: true })

    const frameIdx = r.buf.indexOf("\n\n")
    if (frameIdx === -1) continue

    const frame = r.buf.slice(0, frameIdx)
    r.buf = r.buf.slice(frameIdx + 2)

    const dataLine = frame
      .split("\n")
      .find((line) => line.startsWith("data: "))

    if (!dataLine) continue

    return JSON.parse(dataLine.slice("data: ".length))
  }

  throw new Error("Timed out waiting for SSE event")
}

describe("A2A server monitoring endpoints", () => {

  test("/monitor/agents lists agents", async () => {
    const runtime = {
      interlocutorName: "Agent",
      runTurn: async (args: {
        onAssistantPassText?: (text: string) => void
      }) => {
        args.onAssistantPassText?.("final\n")
      },
    } as unknown as PersistedAgentRuntime

    const handler1 = new A2AAgentHandler({
      runtime,
      card: mkCard(),
      fastPathMs: 0,
    })

    const handler2 = new A2AAgentHandler({
      runtime,
      card: mkCard(),
      fastPathMs: 0,
    })

    const transport1 = new JsonRpcTransportHandler(handler1)
    const transport2 = new JsonRpcTransportHandler(handler2)

    const agents = new Map<string, A2AServerAgent>()
    agents.set("test1", {
      agentId: "test1",
      handler: handler1,
      card: mkCard(),
      transport: transport1,
    })
    agents.set("test2", {
      agentId: "test2",
      handler: handler2,
      card: mkCard(),
      transport: transport2,
    })

    const server = startA2AServer({
      host: "127.0.0.1",
      port: 0,
      agents,
    })

    try {
      const base = `http://127.0.0.1:${server.port}`
      const res = await fetch(`${base}/monitor/agents`)
      expect(res.status).toBe(200)

      const body = (await res.json()) as {
        agents?: Array<{ agentId?: string; monitoring?: boolean }>
      }

      const ids = (body.agents ?? []).map((a) => a.agentId)
      expect(ids).toContain("test1")
      expect(ids).toContain("test2")

      for (const a of body.agents ?? []) {
        expect(a.monitoring).toBe(true)
      }
    } finally {
      void server.stop()
    }
  })

  test("/monitor/tasks aggregates tasks across agents", async () => {
    const runtime = {
      interlocutorName: "Agent",
      runTurn: async (args: {
        onAssistantPassText?: (text: string) => void
      }) => {
        args.onAssistantPassText?.("final\n")
      },
    } as unknown as PersistedAgentRuntime

    const handler1 = new A2AAgentHandler({
      runtime,
      card: mkCard(),
      fastPathMs: 0,
    })

    const handler2 = new A2AAgentHandler({
      runtime,
      card: mkCard(),
      fastPathMs: 0,
    })

    const transport1 = new JsonRpcTransportHandler(handler1)
    const transport2 = new JsonRpcTransportHandler(handler2)

    const agents = new Map<string, A2AServerAgent>()
    agents.set("test1", {
      agentId: "test1",
      handler: handler1,
      card: mkCard(),
      transport: transport1,
    })
    agents.set("test2", {
      agentId: "test2",
      handler: handler2,
      card: mkCard(),
      transport: transport2,
    })

    const server = startA2AServer({
      host: "127.0.0.1",
      port: 0,
      agents,
    })

    try {
      const t1 = (await handler1.sendMessage(
        mkSendParams({ text: "hi1", contextId: "c" })
      )) as Task

      const t2 = (await handler2.sendMessage(
        mkSendParams({ text: "hi2", contextId: "c" })
      )) as Task

      await waitForTerminal(handler1, t1.id)
      await waitForTerminal(handler2, t2.id)

      const base = `http://127.0.0.1:${server.port}`

      const listRes = await fetch(`${base}/monitor/tasks`)
      expect(listRes.status).toBe(200)

      const list = (await listRes.json()) as {
        tasks?: Array<{ agentId?: string; taskId?: string }>
      }

      const byTask = new Map((list.tasks ?? []).map((t) => [t.taskId, t]))
      expect(byTask.get(t1.id)?.agentId).toBe("test1")
      expect(byTask.get(t2.id)?.agentId).toBe("test2")

      const oneRes = await fetch(`${base}/monitor/tasks/${t1.id}`)
      expect(oneRes.status).toBe(200)

      const one = (await oneRes.json()) as {
        agentId?: string
        snapshot?: { taskId?: string }
      }

      expect(one.agentId).toBe("test1")
      expect(one.snapshot?.taskId).toBe(t1.id)

      const filtered = await fetch(`${base}/monitor/tasks?agentId=test2`)
      expect(filtered.status).toBe(200)

      const filteredBody = (await filtered.json()) as {
        tasks?: Array<{ agentId?: string }>
      }

      for (const t of filteredBody.tasks ?? []) {
        expect(t.agentId).toBe("test2")
      }
    } finally {
      void server.stop()
    }
  })

  test("/monitor/events emits task lifecycle events", async () => {
    const runtime = {
      interlocutorName: "Agent",
      runTurn: async (args: {
        onAssistantPassText?: (text: string) => void
      }) => {
        await new Promise((r) => setTimeout(r, 10))
        args.onAssistantPassText?.("final\n")
      },
    } as unknown as PersistedAgentRuntime

    const handler1 = new A2AAgentHandler({
      runtime,
      card: mkCard(),
      fastPathMs: 0,
    })

    const handler2 = new A2AAgentHandler({
      runtime,
      card: mkCard(),
      fastPathMs: 0,
    })

    const transport1 = new JsonRpcTransportHandler(handler1)
    const transport2 = new JsonRpcTransportHandler(handler2)

    const agents = new Map<string, A2AServerAgent>()
    agents.set("test1", {
      agentId: "test1",
      handler: handler1,
      card: mkCard(),
      transport: transport1,
    })
    agents.set("test2", {
      agentId: "test2",
      handler: handler2,
      card: mkCard(),
      transport: transport2,
    })

    const server = startA2AServer({
      host: "127.0.0.1",
      port: 0,
      agents,
    })

    const base = `http://127.0.0.1:${server.port}`
    const ac = new AbortController()

    try {
      const res = await fetch(`${base}/monitor/events`, { signal: ac.signal })
      expect(res.status).toBe(200)

      const r = mkSseReader(res)

      // Trigger a task after the monitor stream is connected.
      void handler2.sendMessage(mkSendParams({ text: "hi", contextId: "c" }))

      let gotCreated = false

      for (let i = 0; i < 20; i++) {
        const ev = (await readNextSseEvent(r, 1000)) as {
          kind?: string
          agentId?: string
          event?: { kind?: string }
        }

        if (
          ev.kind === "event" &&
          ev.agentId === "test2" &&
          ev.event?.kind === "created"
        ) {
          gotCreated = true
          break
        }
      }

      expect(gotCreated).toBe(true)
    } finally {
      ac.abort()
      void server.stop()
    }
  })
})
