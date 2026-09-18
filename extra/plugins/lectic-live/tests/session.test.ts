import { expect, test } from "bun:test"
import {
  CreationRejected, describeFailure, liveConnector, SessionFailure,
} from "../session"
import { startServer } from "./openai-fixture"
import type { LiveEvent } from "../protocol"

class Socket extends EventTarget {
  readyState: number = WebSocket.OPEN
  sent: any[] = []
  constructor() {
    super()
    setTimeout(() => this.dispatchEvent(new Event("open")), 1)
  }
  send(raw: string) {
    const e = JSON.parse(raw)
    this.sent.push(e)
    if (e.type === "session.close") queueMicrotask(() => this.event({
      type: "session.closed", session: { id: "opaque/session" },
      reason: "client_request", usage: { seconds: 12 },
    }))
    else queueMicrotask(() => this.event({
      type: "session.commentary.appended", client_event_id: e.event_id,
    }))
  }
  event(value: unknown) {
    this.dispatchEvent(new MessageEvent("message", {
      data: JSON.stringify(value),
    }))
  }
  close() { this.dispatchEvent(new Event("close")) }
}

test("creates once, attaches with local key, appends and closes gracefully",
  async () => {
    const calls: any[] = []
    const events: LiveEvent[] = []
    let socket: Socket | undefined
    let lost = 0
    const connect = liveConnector("private-key", "marin", {
      fetch: (async (url: string, init: RequestInit) => {
        calls.push({ url, init })
        return Response.json({
          session: { id: "opaque/session" },
          transport: { type: "webrtc", sdp: "answer" },
        })
      }) as typeof fetch,
      socket: (url, options) => {
        expect(url).toBe("wss://api.openai.com/v1/live/sessions/"
          + "opaque%2Fsession/attach")
        expect(options.headers).toEqual({
          Authorization: "Bearer private-key",
        })
        socket = new Socket()
        return socket as unknown as WebSocket
      },
    })
    const session = await connect("offer", e => events.push(e),
      () => { lost++ }, new AbortController().signal, {
        version: 1, conversationId: crypto.randomUUID(), incomplete: false,
        fragments: [{ sessionId: "old", sequence: 1, speaker: "user",
          text: "Remember the A lookup" }], tasks: [],
      })
    expect(calls).toHaveLength(1)
    const body = JSON.parse(calls[0].init.body)
    expect(body.session.store).toBe(false)
    expect(body.session.input).toEqual([{ type: "message", role: "user",
      content: [{ type: "input_text", text: "Remember the A lookup" }] }])
    expect(body.session.audio).toEqual({ output: { voice: "marin" } })
    expect(body.session.client.data_channel.allowed_client_events).toEqual([])
    expect(body.transport).toEqual({ type: "webrtc", sdp: "offer" })
    expect(socket!.sent).toHaveLength(0) // Never send session.start.
    await session.client.append("commentary", "d1", "A grounded answer")
    expect(await session.close()).toBe(true)
    expect(events.at(-1)?.type).toBe("session.closed")
    expect(lost).toBe(0)
    expect(socket!.sent.map(e => e.type)).toEqual([
      "session.commentary.append", "session.close",
    ])
  })

test("creation rejection is not retried and carries a bounded diagnostic",
  async () => {
    let calls = 0
    const connect = liveConnector("key", undefined, {
      fetch: (async () => {
        calls++
        return Response.json({ error: {
          code: "model_not_found",
          message: "The model `gpt-live-1` does not exist for key sk-abc123",
        } }, { status: 403 })
      }) as unknown as typeof fetch,
      socket: () => { throw new Error("must not attach") },
    })
    await expect(connect("offer", () => {}, () => {},
      new AbortController().signal)).rejects.toThrow(
        "HTTP 403): model_not_found",
      )
    expect(calls).toBe(1)
  })

test("diagnostics allow codes, never provider-controlled text", () => {
  for (const body of [
    "", "   ", "<html>Authorization: Bearer secret</html>",
    JSON.stringify({ unrelated: "secret" }), "x".repeat(10_000),
    JSON.stringify({ error: { code: "secret", message: "private prompt" } }),
  ]) expect(describeFailure(body)).toBe("")
  expect(describeFailure(JSON.stringify({ error: {
    code: "invalid_api_key", message: "Authorization: Bearer private",
  } }))).toBe(": invalid_api_key")
})

test("sideband handshake failure reports the close code", async () => {
  const socket = new EventTarget() as EventTarget & {
    readyState: number; send(): void; close(): void
  }
  socket.readyState = WebSocket.CLOSED
  socket.send = () => {}
  socket.close = () => {}
  setTimeout(() => {
    socket.dispatchEvent(new Event("error"))
    socket.dispatchEvent(new CloseEvent("close", {
      code: 1008, reason: "unknown session",
    }))
  }, 1)
  const connect = liveConnector("key", undefined, {
    fetch: (async () => Response.json({
      session: { id: "s" }, transport: { type: "webrtc", sdp: "answer" },
    })) as unknown as typeof fetch,
    socket: () => socket as unknown as WebSocket,
  })
  await expect(connect("offer", () => {}, () => {},
    new AbortController().signal)).rejects.toThrow(
      "Sideband attachment failed (closed 1008)",
    )
})

test("transport close is uncertain without terminal event", async () => {
  const socket = new Socket()
  let lost = 0
  const connect = liveConnector("key", undefined, {
    fetch: (async () => Response.json({
      session: { id: "s" }, transport: { type: "webrtc", sdp: "answer" },
    })) as unknown as typeof fetch,
    socket: () => socket as unknown as WebSocket,
  })
  const session = await connect("offer", () => {}, () => { lost++ },
    new AbortController().signal)
  socket.readyState = WebSocket.CLOSED
  socket.close()
  expect(lost).toBe(1)
  expect(await session.close()).toBe(false)
})

test("concurrent close sends once and reuses terminal usage", async () => {
  const socket = new Socket()
  const events: LiveEvent[] = []
  const connect = liveConnector("key", undefined, {
    fetch: (async () => Response.json({
      session: { id: "opaque/session" },
      transport: { type: "webrtc", sdp: "answer" },
    })) as unknown as typeof fetch,
    socket: () => socket as unknown as WebSocket,
  })
  const session = await connect("offer", e => events.push(e), () => {},
    new AbortController().signal)
  expect(await Promise.all([session.close(), session.close()]))
    .toEqual([true, true])
  expect(await session.close()).toBe(true)
  expect(socket.sent).toHaveLength(1)
  expect(events.filter(e => e.type === "session.closed")).toHaveLength(1)
})

test("wrong-owner terminal events never finalize or reach the controller",
  async () => {
    const socket = new Socket()
    const events: LiveEvent[] = []
    let lost = 0
    const connect = liveConnector("key", undefined, {
      fetch: (async () => Response.json({
        session: { id: "s" }, transport: { type: "webrtc", sdp: "answer" },
      })) as unknown as typeof fetch,
      socket: () => socket as unknown as WebSocket,
    })
    const session = await connect("offer", e => events.push(e),
      () => { lost++ }, new AbortController().signal)
    socket.readyState = WebSocket.CLOSED
    socket.event({ type: "session.closed", session: { id: "other" },
      reason: "closed", usage: { seconds: 99 } })
    socket.close()
    expect(lost).toBe(1)
    expect(events).toHaveLength(0)
    expect(await session.close()).toBe(false)
  })

test("oversized HTTP bodies are cancelled without attaching or retrying",
  async () => {
    let cancelled = false
    let calls = 0
    const connect = liveConnector("key", undefined, {
      fetch: (async () => {
        calls++
        return new Response(new ReadableStream({
          pull(controller) { controller.enqueue(new Uint8Array(64 * 1024)) },
          cancel() { cancelled = true },
        }))
      }) as unknown as typeof fetch,
      socket: () => { throw new Error("must not attach") },
    })
    await expect(connect("offer", () => {}, () => {},
      new AbortController().signal)).rejects.toThrow("Oversized response")
    expect(cancelled).toBe(true)
    expect(calls).toBe(1)
  })

test("failed close sends never falsely finalize", async () => {
  const socket = new Socket()
  socket.send = () => { throw new Error("disconnected during close") }
  const connect = liveConnector("key", undefined, {
    fetch: (async () => Response.json({
      session: { id: "s" }, transport: { type: "webrtc", sdp: "answer" },
    })) as unknown as typeof fetch,
    socket: () => socket as unknown as WebSocket,
  })
  const session = await connect("offer", () => {}, () => {},
    new AbortController().signal)
  expect(await session.close()).toBe(false)
})

for (const status of [400, 401, 403, 404, 422, 429, 408, 500, 503]) {
  test(`creation HTTP ${status} has explicit rejection classification`,
    async () => {
      let calls = 0
      const connect = liveConnector("key", undefined, {
        fetch: (async () => {
          calls++
          return Response.json({ error: {
            code: "invalid_value", type: "invalid_request_error",
            param: "session.input[0].content[0].type",
            message: "private transcript",
          } }, { status })
        }) as unknown as typeof fetch,
        socket: () => { throw new Error("must not attach") },
      })
      const error = await connect("offer", () => {}, () => {},
        new AbortController().signal).catch(error => error)
      expect(error).toBeInstanceOf(SessionFailure)
      expect(error instanceof CreationRejected)
        .toBe(![408, 500, 503].includes(status))
      expect(error.message).toContain("session.input[0].content[0].type")
      expect(error.message).not.toContain("private transcript")
      expect(calls).toBe(1)
    })
}

test("diagnostics fall back to known type and reject arbitrary field paths",
  () => {
    for (const param of [
      "private transcript", "session.input[0].private_secret",
      "session.input[0].content[0].type\nprivate", "session.input[999999]",
      "session.input[0].content[0].type\n",
    ]) {
      expect(describeFailure(JSON.stringify({ error: {
        code: "unrecognized", type: "invalid_request_error", param,
        message: "private transcript",
      } }))).toBe(": invalid_request_error")
    }
    expect(describeFailure(JSON.stringify({ error: {
      code: "unrecognized", type: "invalid_request_error",
      param: "session.input[1].role",
    } }))).toBe(": invalid_request_error; param=session.input[1].role")
  })

test("rejection survives an unreadable diagnostic body", async () => {
  const connect = liveConnector("key", undefined, {
    fetch: (async () => new Response(new ReadableStream({
      start(controller) { controller.error(new Error("body lost")) },
    }), { status: 400 })) as unknown as typeof fetch,
    socket: () => { throw new Error("must not attach") },
  })
  await expect(connect("offer", () => {}, () => {},
    new AbortController().signal)).rejects.toBeInstanceOf(CreationRejected)
})

// Exercise the actual server -> history -> HTTP adapter boundary. The
// provider stub accepts only the documented role-specific message format.
test("idle wake creates a fresh session with valid transcript history",
  async () => {
    const requests: any[] = []
    let socket: Socket | undefined
    const connect = liveConnector("key", undefined, {
      fetch: (async (_url, init) => {
        const body = JSON.parse(init!.body as string)
        requests.push(body)
        const valid = (body.session.input ?? []).every((m: any) =>
          m.type === "message" && m.content.length === 1
          && m.content[0].type === (m.role === "user"
            ? "input_text" : "output_text"))
        if (!valid) return Response.json({ error: {
          code: "invalid_value", param: "session.input",
        } }, { status: 400 })
        return Response.json({ session: { id: "opaque/session" },
          transport: { type: "webrtc", sdp: "answer" } })
      }) as typeof fetch,
      socket: () => {
        socket = new Socket()
        return socket as unknown as WebSocket
      },
    })
    const server = startServer({ connect, idleTimeout: 1,
      backend: async () => { throw new Error("must not delegate") } })
    const request = (path: string, body = {}) => fetch(server.origin + path, {
      method: "POST", body: JSON.stringify(body), headers: {
        Origin: server.origin, Authorization: `Bearer ${server.secret}`,
        "Content-Type": "application/json",
      },
    })
    try {
      expect((await request("/start", { sdp: "first offer" })).status)
        .toBe(200)
      await request("/ready", { events: [JSON.stringify({
        type: "session.started", session: { id: "opaque/session" },
      })] })
      socket!.event({ type: "session.input_transcript.delta",
        delta: "Where is A?", start_ms: 0, end_ms: 1 })
      socket!.event({ type: "session.output_transcript.delta",
        delta: "In a.ts", start_ms: 1, end_ms: 2 })
      await Bun.sleep(1050)
      expect(await (await request("/idle", {
        sessionId: "opaque/session",
      })).json()).toEqual({ idle: true })
      expect((await request("/start", { sdp: "wake offer" })).status)
        .toBe(200)
      expect(requests).toHaveLength(2)
      expect(requests[0].session).not.toHaveProperty("input")
      expect(requests[1].session.input).toEqual([
        { type: "message", role: "user",
          content: [{ type: "input_text", text: "Where is A?" }] },
        { type: "message", role: "assistant",
          content: [{ type: "output_text", text: "In a.ts" }] },
      ])
      expect(requests[1].session.store).toBe(false)
      expect(requests[1].transport.sdp).toBe("wake offer")
      expect((await (await request("/state")).json()).runs).toBe(0)
    } finally { await server.stop() }
  })
