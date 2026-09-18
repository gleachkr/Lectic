import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { History, historyRoot, loadHistory } from "../history"
import { workspace } from "./helpers"
import { expect, test } from "bun:test"
import { startServer, type ServerOptions } from "./openai-fixture"
import { CreationRejected } from "../session"
import { LiveClient } from "../live-client"
import type { LiveEvent } from "../protocol"
import type { HistoryContext } from "../history"

function fixture(options: Partial<ServerOptions> = {}) {
  let receive: ((e: LiveEvent) => void) | undefined
  let lose: (() => void) | undefined
  let creates = 0
  let closes = 0
  const sent: any[] = []
  const previous: (HistoryContext | undefined)[] = []
  const connections: { receive: (e: LiveEvent) => void; lose(): void }[] = []
  const makeClient = () => {
    const client = new LiveClient({ send: raw => {
    const event = JSON.parse(raw)
    sent.push(event)
    queueMicrotask(() => client.receive(JSON.stringify({
      type: "session.commentary.appended", client_event_id: event.event_id,
    })))
  } })
    return client
  }
  const server = startServer({
    backend: async () => ({
      status: "completed", summary: "Grounded answer",
    }),
    connect: async (_sdp, onEvent, onLost, _signal, history) => {
      creates++
      receive = onEvent
      lose = onLost
      previous.push(history)
      connections.push({ receive: onEvent, lose: onLost })
      const client = makeClient()
      const id = `s${creates}`
      let closed = false
      return {
        id, sdp: "answer", client,
        close: async () => {
          if (!closed) {
            closed = true
            closes++
            onEvent({ type: "session.closed", session: { id },
              usage: { seconds: 30 }, reason: "client_request" })
            client.disconnect()
          }
          return true
        },
      }
    },
    ...options,
  })
  const request = (path: string, body = {}, headers = {}) => fetch(
    server.origin + path, {
      method: "POST", body: JSON.stringify(body),
      headers: {
        Origin: server.origin, Authorization: `Bearer ${server.secret}`,
        "Content-Type": "application/json", ...headers,
      },
    },
  )
  return {
    server, request, sent, previous, connections,
    receive: (e: LiveEvent) => receive!(e), lose: () => lose!(),
    creates: () => creates, closes: () => closes,
  }
}

test("local controls enforce host, origin, secret and fixed server config",
  async () => {
    const f = fixture()
    try {
      const page = await fetch(f.server.origin)
      expect(page.headers.get("content-security-policy"))
        .toContain("frame-ancestors 'none'")
      expect(await page.text()).not.toContain(f.server.secret)
      expect(f.creates()).toBe(0)
      for (const headers of [
        { Origin: "https://evil.example" }, { Authorization: "bad" },
        { Host: "evil.example" },
      ]) expect((await f.request("/start", { sdp: "offer" }, headers)).status)
        .toBe(403)
      expect((await f.request("/start", { sdp: "offer" })).status).toBe(200)
      expect((await f.request("/start", { sdp: "offer" })).status).toBe(409)
      expect(f.creates()).toBe(1)
      expect((await f.request("/ready", { events: [JSON.stringify({
        type: "session.started", session: { id: "wrong" },
      })] })).status).toBe(400)
    } finally { await f.server.stop() }
  })

test("bootstrap deduplicates, renders inert captions, and delegates once",
  async () => {
    const f = fixture()
    try {
      await f.request("/start", { sdp: "offer" })
      const speech: LiveEvent = {
        type: "session.input_transcript.delta", event_id: "t1",
        delta: "<script>inspect repository</script>", start_ms: 0, end_ms: 10,
      }
      const task: LiveEvent = {
        type: "session.delegation.created", offset_ms: 10,
        delegation: { id: "d", type: "delegation", target: "client" },
      }
      f.receive(speech)
      expect((await (await f.request("/state")).json()).runs).toBe(0)
      f.receive(task)
      await f.request("/ready", { events: [
        { type: "session.started", session: { id: "s1" } }, speech, task,
      ].map(e => JSON.stringify(e)) })
      await Bun.sleep(850)
      const state = await (await f.request("/state")).json()
      expect(state.runs).toBe(1)
      expect(state.captions).toHaveLength(1)
      expect(f.sent).toHaveLength(1)
      expect(f.sent[0].content).toBe("Grounded answer")
      f.receive({ type: "session.usage.updated", usage: { seconds: 10 } })
      f.receive({ type: "session.usage.updated", usage: { seconds: 12 } })
      expect((await (await f.request("/state")).json()).seconds).toBe(12)
      await f.request("/end")
      expect(f.closes()).toBe(1)
      expect((await (await f.request("/state")).json()).confirmed).toBe(true)
    } finally { await f.server.stop() }
  })

test("sideband loss stops execution and never reconnects", async () => {
  const f = fixture()
  try {
    await f.request("/start", { sdp: "offer" })
    f.lose()
    await Bun.sleep(20)
    expect((await (await f.request("/state")).json()).ending).toBe(true)
    expect(f.creates()).toBe(1)
    expect(f.closes()).toBe(1)
  } finally { await f.server.stop() }
})

test("Clear forgets local content, cancels work, and retains execution IDs",
  async () => {
    let signal: AbortSignal | undefined
    const f = fixture({ backend: async (_context, s) => {
      signal = s
      await new Promise<void>(resolve => {
        s.addEventListener("abort", () => resolve(), { once: true })
      })
      return { status: "completed", summary: "private result" }
    } })
    try {
      await f.request("/start", { sdp: "offer" })
      f.receive({ type: "session.input_transcript.delta", event_id: "speech",
        delta: "private request", start_ms: 0, end_ms: 10 })
      const task: LiveEvent = {
        type: "session.delegation.created", offset_ms: 10,
        delegation: {
          id: "private-id", type: "delegation", target: "client",
        },
      }
      f.receive(task)
      await Bun.sleep(850)
      expect(signal).toBeDefined()
      await f.request("/clear")
      expect(signal!.aborted).toBe(true)
      await Bun.sleep(20)
      f.receive(task)
      const state = await (await f.request("/state")).json()
      expect(state.captions).toEqual([])
      expect(state.runs).toBe(1)
      expect(state.tasks[0].outcome).toBe("cancelled")
      expect(JSON.stringify(state)).not.toContain("private")
      expect(f.sent).toEqual([])
    } finally { await f.server.stop() }
  })

test("heartbeat loss aborts active work without a replacement",
  async () => {
    let signal: AbortSignal | undefined
    const f = fixture({ heartbeatMs: 1000, watchdogMs: 5,
      backend: async (_context, s) => {
        signal = s
        await new Promise<void>(resolve => {
          s.addEventListener("abort", () => resolve(), { once: true })
        })
        return { status: "completed", summary: "late result" }
      },
    })
    try {
      await f.request("/start", { sdp: "offer" })
      f.receive({ type: "session.input_transcript.delta", delta: "inspect A",
        start_ms: 0, end_ms: 10 })
      f.receive({ type: "session.delegation.created", offset_ms: 10,
        delegation: { id: "d", type: "delegation", target: "client" } })
      await Bun.sleep(1100)
      expect(signal?.aborted).toBe(true)
      await f.server.stopped
      await expect(f.request("/state")).rejects.toThrow()
      expect(f.sent).toEqual([])
      expect(f.creates()).toBe(1)
      expect(f.closes()).toBe(1)
      await expect(f.request("/start", { sdp: "offer" })).rejects.toThrow()
    } finally { await f.server.stop() }
  })

test("startup errors cannot leak raw credentials into controls or logs",
  async () => {
    const messages: unknown[] = []
    const original = console.error
    console.error = (...args) => { messages.push(args) }
    const f = fixture({ connect: async () => {
      throw new Error("Authorization: Bearer private-credential; user prompt")
    } })
    try {
      const response = await f.request("/start", { sdp: "offer" })
      expect(response.status).toBe(502)
      const body = await response.text()
      expect(body).not.toContain("private-credential")
      expect(body).not.toContain("user prompt")
      expect(JSON.stringify(messages)).not.toContain("private-credential")
      const state = await (await f.request("/state")).json()
      expect(state.usage.final).toBe(false)
      expect(state.usage.estimatedBillableSeconds).toBe(15)
      expect(state.diagnostics.some((e: any) => e.code === "startup_failed"))
        .toBe(true)
    } finally { console.error = original; await f.server.stop() }
  })

test("terminal accounting survives delayed usage and simultaneous End",
  async () => {
    const f = fixture()
    try {
      await f.request("/start", { sdp: "offer" })
      for (const seconds of [20, 20, 15]) {
        f.receive({ type: "session.usage.updated", usage: { seconds } })
      }
      expect((await (await f.request("/state")).json()).seconds).toBe(20)
      f.receive({ type: "session.closed", session: { id: "s1" },
        reason: "done", usage: { seconds: 21 } })
      f.receive({ type: "session.usage.updated", usage: { seconds: 99 } })
      await Promise.all([f.request("/end"), f.request("/end")])
      const state = await (await f.request("/state")).json()
      expect(state.usage.final).toBe(true)
      expect(state.seconds).toBe(21)
      expect(f.closes()).toBe(1)
    } finally { await f.server.stop() }
  })

test("Clear during attachment revokes buffered work and forgets its context",
  async () => {
    let attached: (() => void) | undefined
    let receive: ((event: LiveEvent) => void) | undefined
    const client = new LiveClient({ send() {} })
    const f = fixture({ connect: async (_sdp, onEvent) => {
      receive = onEvent
      await new Promise<void>(resolve => { attached = resolve })
      return { id: "s", sdp: "answer", client,
        close: async () => { client.disconnect(); return false } }
    } })
    try {
      const starting = f.request("/start", { sdp: "offer" })
      const deadline = Date.now() + 2000
      while (!attached && Date.now() < deadline) await Bun.sleep(1)
      expect(attached).toBeDefined()
      receive!({ type: "session.input_transcript.delta", delta: "private",
        start_ms: 0, end_ms: 10 })
      receive!({ type: "session.delegation.created", offset_ms: 10,
        delegation: { id: "d", type: "delegation", target: "client" } })
      await f.request("/clear")
      attached!()
      await starting
      await Bun.sleep(20)
      const state = await (await f.request("/state")).json()
      expect(state.runs).toBe(0)
      expect(state.captions).toEqual([])
      expect(state.tasks[0].outcome).toBe("cancelled")
      expect(JSON.stringify(state)).not.toContain("private")
    } finally { attached?.(); await f.server.stop() }
  })


test("kept context survives End and resumes without replay", async () => {
  const ws = await workspace()
  const root = historyRoot(ws.env)
  const history = new History(ws, root)
  const f = fixture({ history })
  try {
    await f.request("/start", { sdp: "offer" })
    f.receive({ type: "session.input_transcript.delta", delta: "inspect A",
      start_ms: 0, end_ms: 1 })
    f.receive({ type: "session.delegation.created", offset_ms: 1,
      delegation: { id: "d", type: "delegation", target: "client" } })
    await Bun.sleep(850)
    await f.request("/end")
    const saved = loadHistory(history.id, root)
    expect(saved.tasks[0]).toMatchObject({
      outcome: "completed", delivery: "acknowledged",
      result: { summary: "Grounded answer" },
    })
    expect(saved.fragments[0].text).toBe("inspect A")
    const nextHistory = new History({ ...ws, resumedFrom: history.id }, root)
    const next = fixture({ previousSession: saved, history: nextHistory })
    try {
      expect(next.creates()).toBe(0)
      await next.request("/start", { sdp: "new offer" })
      const state = await (await next.request("/state")).json()
      expect(state.runs).toBe(0)
      expect(next.sent).toEqual([])
      await next.request("/clear")
      expect(loadHistory(nextHistory.id, root).fragments).toEqual([])
      expect(loadHistory(nextHistory.id, root).tasks).toEqual([])
      // Clear changes future context, not the archive the user opted into.
      expect(await readFile(join(nextHistory.dir, "events.jsonl"), "utf8"))
        .toContain("Grounded answer")
    } finally { await next.server.stop() }
  } finally {
    await f.server.stop()
    await ws.cleanup()
  }
})

test("Clear before Start discards loaded context and the new checkpoint",
  async () => {
    const ws = await workspace()
    const root = historyRoot(ws.env)
    const history = new History(ws, root)
    const f = fixture({ history, previousSession: {
      version: 1, conversationId: crypto.randomUUID(), incomplete: false,
      fragments: [{ sessionId: "old", sequence: 1, speaker: "user",
        text: "prior session" }], tasks: [],
    } })
    try {
      expect(loadHistory(history.id, root).fragments).toHaveLength(1)
      await f.request("/clear")
      expect(f.creates()).toBe(0)
      expect(loadHistory(history.id, root).fragments).toEqual([])
      await f.request("/start", { sdp: "offer" })
      await f.request("/end")
      expect(loadHistory(history.id, root).fragments).toEqual([])
    } finally {
      await f.server.stop()
      await ws.cleanup()
    }
  })

async function ready(f: ReturnType<typeof fixture>, id = "s1") {
  const started = await f.request("/start", { sdp: "offer" })
  expect(started.status).toBe(200)
  expect(await started.json()).toMatchObject({ sessionId: id })
  expect((await f.request("/ready", { events: [JSON.stringify({
    type: "session.started", session: { id },
  })] })).status).toBe(200)
}

test("idle reconnect reuses bounded CLI history without disk or job replay",
  async () => {
    const f = fixture({ idleTimeout: 1 })
    try {
      await ready(f)
      f.receive({ type: "session.input_transcript.delta", delta: "inspect A",
        start_ms: 0, end_ms: 10 })
      f.receive({ type: "session.delegation.created", offset_ms: 10,
        delegation: { id: "d1", type: "delegation", target: "client" } })
      expect(await (await f.request("/idle", { sessionId: "s1" })).json())
        .toEqual({ idle: false })
      await Bun.sleep(1100)
      expect(await (await f.request("/idle", { sessionId: "s1" })).json())
        .toEqual({ idle: true })
      const state = await (await f.request("/state")).json()
      expect(state).toMatchObject({
        sleeping: true, ending: false, confirmed: true, ready: false,
        runs: 1, idleTimeout: 1,
      })
      expect(state.usage).toMatchObject({ seconds: 30, final: true })
      expect(f.closes()).toBe(1)
      // Delayed old callbacks cannot contaminate the next owner or end it.
      const old = f.connections[0]
      old.receive({ type: "session.input_transcript.delta", delta: "stale",
        start_ms: 10, end_ms: 11 })
      old.lose()
      await ready(f, "s2")
      expect(f.previous[1]?.fragments.map(f => f.text)).toEqual(["inspect A"])
      expect(f.previous[1]?.tasks[0]).toMatchObject({
        sessionId: "s1", outcome: "completed", delivery: "acknowledged",
      })
      expect(f.sent).toHaveLength(1)
      old.receive({ type: "session.closed", session: { id: "s1" },
        usage: { seconds: 999 }, reason: "client_request" })
      old.lose()
      expect((await f.request("/idle", { sessionId: "s1" })).status)
        .toBe(409)
      expect(await (await f.request("/idle", { sessionId: "s2" })).json())
        .toEqual({ idle: true })
      await ready(f, "s3")
      expect(f.previous[2]?.fragments.map(f => f.text)).toEqual(["inspect A"])
      expect(f.previous[2]?.tasks).toHaveLength(1)
      expect((await (await f.request("/state")).json()).usage)
        .toMatchObject({ seconds: 60, estimatedBillableSeconds: 75 })
      expect(f.sent).toHaveLength(1)
      await f.request("/end")
      expect((await f.request("/start", { sdp: "offer" })).status).toBe(409)
    } finally { await f.server.stop() }
  })

test("idle close is serialized; unconfirmed shutdown never permits wake",
  async () => {
    let close!: (confirmed: boolean) => void
    let creates = 0
    const closing = new Promise<boolean>(resolve => { close = resolve })
    const f = fixture({ connect: async () => {
      creates++
      return { id: "s1", sdp: "answer",
        client: new LiveClient({ send() {} }),
        close: () => closing,
      }
    } })
    try {
      await ready(f)
      const idle = f.request("/idle", { sessionId: "s1" })
      while (!(await (await f.request("/state")).json()).idling) {
        await Bun.sleep(1)
      }
      expect((await f.request("/start", { sdp: "offer" })).status).toBe(409)
      close(false)
      expect(await (await idle).json()).toEqual({ idle: false })
      await f.request("/end")
      expect((await f.request("/start", { sdp: "offer" })).status).toBe(409)
      expect(creates).toBe(1)
    } finally { close?.(false); await f.server.stop() }
  })

test("idle pauses elapsed budget but wake cannot reset accumulated usage",
  async () => {
    const f = fixture({ maxSessionSeconds: 46, watchdogMs: 5 })
    try {
      await ready(f)
      await f.request("/idle", { sessionId: "s1" })
      const elapsed = (await (await f.request("/state")).json()).elapsed
      await Bun.sleep(40)
      expect((await (await f.request("/state")).json()).elapsed).toBe(elapsed)
      await ready(f, "s2")
      f.receive({ type: "session.usage.updated", usage: { seconds: 16 } })
      await Bun.sleep(20)
      const state = await (await f.request("/state")).json()
      expect(state.ending).toBe(true)
      expect(state.diagnostics.some((e: any) => e.code === "budget_reached"))
        .toBe(true)
      expect((await f.request("/start", { sdp: "offer" })).status).toBe(409)
    } finally { await f.server.stop() }
  })

test("heartbeat loss and End are terminal even while idle", async () => {
  const f = fixture({ heartbeatMs: 30, watchdogMs: 5 })
  try {
    await ready(f)
    await f.request("/idle", { sessionId: "s1" })
    await f.server.stopped
    await expect(f.request("/state")).rejects.toThrow()
    expect(f.closes()).toBe(1)
    await expect(f.request("/start", { sdp: "offer" })).rejects.toThrow()
  } finally { await f.server.stop() }
})

test("End during idle close cannot later transition back to sleeping",
  async () => {
    let complete!: () => void
    let receive!: (event: LiveEvent) => void
    const closing = new Promise<boolean>(resolve => {
      complete = () => {
        receive({ type: "session.closed", session: { id: "s1" },
          usage: { seconds: 30 }, reason: "client_request" })
        resolve(true)
      }
    })
    const f = fixture({ connect: async (_sdp, onEvent) => {
      receive = onEvent
      return { id: "s1", sdp: "answer",
        client: new LiveClient({ send() {} }), close: () => closing }
    } })
    try {
      await ready(f)
      const idle = f.request("/idle", { sessionId: "s1" })
      while (!(await (await f.request("/state")).json()).idling) {
        await Bun.sleep(1)
      }
      const end = f.request("/end")
      while (!(await (await f.request("/state")).json()).ending) {
        await Bun.sleep(1)
      }
      complete()
      await end
      expect(await (await idle).json()).toEqual({ idle: false })
      const state = await (await f.request("/state")).json()
      expect(state).toMatchObject({ ending: true, sleeping: false })
      expect((await f.request("/start", { sdp: "offer" })).status).toBe(409)
    } finally { complete(); await f.server.stop() }
  })

for (const rejected of [false, true]) {
  test(`idle startup failure is terminal; explicit rejection: ${rejected}`,
  async () => {
    let calls = 0
    const f = fixture({ connect: async (_sdp, onEvent) => {
      if (++calls > 1) {
        throw rejected ? new CreationRejected("HTTP 400")
          : new Error("Wake startup failed")
      }
      return { id: "s1", sdp: "answer",
        client: new LiveClient({ send() {} }),
        close: async () => {
          onEvent({ type: "session.closed", session: { id: "s1" },
            usage: { seconds: 30 }, reason: "client_request" })
          return true
        },
      }
    } })
    try {
      await ready(f)
      await f.request("/idle", { sessionId: "s1" })
      expect((await f.request("/ready", { events: [] })).status).toBe(409)
      expect((await f.request("/start", { sdp: "offer" })).status).toBe(502)
      expect((await f.request("/start", { sdp: "offer" })).status).toBe(409)
      const state = await (await f.request("/state")).json()
      expect(state.usage).toMatchObject({
        seconds: 30, estimatedBillableSeconds: rejected ? 30 : 45,
        final: rejected,
      })
      expect(state.confirmed).toBe(rejected)
      expect(state.diagnostics.some((e: any) =>
        e.code === "finalization_uncertain")).toBe(!rejected)
      expect(calls).toBe(2)
    } finally { await f.server.stop() }
  })
}

test("terminal bootstrap cannot mark a closed session ready", async () => {
  const f = fixture()
  try {
    await f.request("/start", { sdp: "offer" })
    const result = await f.request("/ready", { events: [
      { type: "session.started", session: { id: "s1" } },
      { type: "session.closed", session: { id: "s1" },
        usage: { seconds: 1 }, reason: "client_request" },
    ].map(e => JSON.stringify(e)) })
    expect(result.status).toBe(409)
    expect((await (await f.request("/state")).json()).ready).toBe(false)
  } finally { await f.server.stop() }
})

test("Clear during idle resets the checkpoint before wake", async () => {
  const previous: HistoryContext = {
    version: 1, conversationId: crypto.randomUUID(), incomplete: false,
    fragments: [{ sessionId: "old", sequence: 1, speaker: "user",
      text: "forget this" }], tasks: [],
  }
  const f = fixture({ previousSession: previous })
  try {
    await ready(f)
    expect(f.previous[0]).toEqual(previous)
    await f.request("/idle", { sessionId: "s1" })
    await f.request("/clear")
    await ready(f, "s2")
    expect(f.previous[1]).toBeUndefined()
    await f.request("/idle", { sessionId: "s2" })
    await ready(f, "s3")
    expect(f.previous[2]?.fragments).toEqual([])
  } finally { await f.server.stop() }
})

test("wake requires budget for a new minimum charge", async () => {
  const f = fixture({ maxSessionSeconds: 40 })
  try {
    await ready(f)
    await f.request("/idle", { sessionId: "s1" })
    expect((await f.request("/start", { sdp: "offer" })).status).toBe(409)
    expect(f.creates()).toBe(1)
    expect(f.closes()).toBe(1)
    expect((await (await f.request("/state")).json()).usage)
      .toMatchObject({ seconds: 30, estimatedBillableSeconds: 30 })
  } finally { await f.server.stop() }
})

for (const endDuringCreation of [false, true]) {
  test(`creation rejection settles usage; early End: ${endDuringCreation}`,
    async () => {
      let reject!: (error: Error) => void
      const f = fixture({ connect: () => new Promise((_resolve, fail) => {
        reject = fail
      }) })
      try {
        const starting = f.request("/start", { sdp: "offer" })
        while (!reject) await Bun.sleep(1)
        const ending = endDuringCreation ? f.request("/end") : undefined
        if (endDuringCreation) {
          while (!(await (await f.request("/state")).json()).ending) {
            await Bun.sleep(1)
          }
        }
        reject(new CreationRejected("Live creation failed (HTTP 400)"))
        const response = await starting
        expect(response.status).toBe(502)
        expect((await response.json()).error)
          .toContain("Startup rejected — no new session created")
        await ending
        expect(await (await f.request("/end")).json())
          .toEqual({ ok: true, confirmed: true })
        const state = await (await f.request("/state")).json()
        expect(state.usage).toMatchObject({
          seconds: 0, final: true, finalSeconds: 0,
          estimatedBillableSeconds: 0, estimatedVoiceCost: 0,
        })
        expect(state.diagnostics.some((e: any) =>
          e.code === "finalization_uncertain")).toBe(false)
        expect((await f.request("/start", { sdp: "retry" })).status)
          .toBe(409)
      } finally { await f.server.stop() }
    })
}

for (const stage of ["unstarted", "active", "sleeping", "ended"]) {
  test(`tab close stops listener and settles cleanup while ${stage}`,
    async () => {
      const f = fixture()
      try {
        // A forged tab-close request must not terminate the controller.
        expect((await f.request("/close", {}, { Authorization: "bad" }))
          .status).toBe(403)
        if (stage !== "unstarted") await ready(f)
        if (stage === "sleeping") {
          await f.request("/idle", { sessionId: "s1" })
        }
        if (stage === "ended") await f.request("/end")
        expect((await f.request("/close")).status).toBe(200)
        await f.server.stopped
        await expect(f.request("/state")).rejects.toThrow()
        expect(f.closes()).toBe(stage === "unstarted" ? 0 : 1)
        await Promise.all([f.server.stop(), f.server.stop()])
      } finally { await f.server.stop() }
    })
}

test("heartbeat expiry stops before paid startup too", async () => {
  const f = fixture({ heartbeatMs: 30, watchdogMs: 5 })
  try {
    await f.request("/state")
    await f.server.stopped
    expect(f.creates()).toBe(0)
    await expect(f.request("/state")).rejects.toThrow()
  } finally { await f.server.stop() }
})
