import { expect, test } from "bun:test"
import { Coordinator } from "../coordinator"
import { parseArgs } from "../lectic-live"
import { LiveClient } from "../live-client"
import { openAIComplete, openAIObservation, openAIProvider } from "../openai"
import { voiceHistory } from "../openai-history"
import { mergeHistory, type HistoryContext } from "../history"
import {
  Lifecycle, MAX_TASK_BYTES, type BackendRequest, type Completion,
  type DeliveryReceipt, type Owner, type ProviderObservation,
  type TranscriptObservation,
} from "../provider"
import { startServer } from "../server"
import type { ContextEnvelope } from "../transcript"

const owner: Owner = {
  provider: "gemini", sessionId: "local-1", sessionIdSource: "local",
}
const request = (
  requestId = "call-1", task = "Inspect A",
): BackendRequest => ({
  type: "request", owner, requestId, task,
})
const speech = (text: string): TranscriptObservation => ({
  type: "transcript", owner, speaker: "user", text,
})
const result = { status: "completed" as const, summary: "Found A" }
const sent: DeliveryReceipt = {
  transmission: "sent", acknowledgment: "unavailable",
}
const until = async (condition: () => boolean) => {
  const deadline = Date.now() + 2000
  while (!condition() && Date.now() < deadline) await Bun.sleep(1)
  expect(condition()).toBe(true)
}

test("explicit task runs without invented speech, offset or media time",
  async () => {
    const contexts: ContextEnvelope[] = []
    const completions: Completion[] = []
    const c = new Coordinator(owner, async context => {
      contexts.push(context)
      return result
    }, async completion => { completions.push(completion); return sent }, 0)
    c.receive(request("call-1", "  inspect A\nexactly  "))
    await c.idle()
    expect(contexts[0]).toMatchObject({
      provider: "gemini", sessionIdSource: "local",
      task: "  inspect A\nexactly  ", fragments: [],
    })
    expect(JSON.parse(JSON.stringify(contexts[0])))
      .not.toHaveProperty("offsetMs")
    expect(completions).toEqual([{ owner, requestId: "call-1",
      outcome: "completed", summary: "Found A" }])
    expect(c.historyContext().tasks[0].context).toContain("inspect A")
    expect(c.diagnostics()[0]).toMatchObject({
      outcome: "completed", delivery: "sent",
    })
    expect(c.status).toContain("acknowledgment unavailable")
  })

test("normal text repeats exactly, ignores interim, keeps receipt order",
  async () => {
    let captured: ContextEnvelope | undefined
    const c = new Coordinator(owner, async context => {
      captured = context
      return result
    }, async () => sent, 10)
    c.receive(request())
    c.receive({ ...speech("interim guess"), interim: true })
    c.receive({ ...speech(" no"), media: { startMs: 100, endMs: 200 } })
    c.receive(speech(" no"))
    c.receive({ ...speech(" yes\n"), media: { startMs: 0, endMs: 50 } })
    await c.idle()
    expect(captured!.fragments.map(f => [f.sequence, f.text])).toEqual([
      [1, " no"], [2, " no"], [3, " yes\n"],
    ])
    expect(captured!.fragments[1].startMs).toBeUndefined()
    expect(captured!.fragments[2].startMs).toBe(0)
    expect(voiceHistory(c.historyContext())[0].content[0].text)
      .toBe(" no no yes\n")
  })

test("only adapter identities deduplicate; owner scopes requests and text",
  async () => {
    const c = new Coordinator(owner, async () => result,
      async () => sent, 0)
    c.receive({ ...request(), owner: { ...owner, provider: "openai" } })
    c.receive({ ...request(), owner: { ...owner, sessionId: "retired" } })
    c.receive({ ...speech("wrong"),
      owner: { ...owner, sessionIdSource: "provider" } })
    c.receive({ ...speech("same"), identity: "fragment-1" })
    c.receive({ ...speech("same"), identity: "fragment-1" })
    c.receive({ ...speech("same"), identity: "fragment-2" })
    c.receive(request())
    c.receive(request())
    await c.idle()
    expect(c.runs).toBe(1)
    expect(c.historyContext().fragments.map(f => f.text))
      .toEqual(["same", "same"])
    const next = new Coordinator({ ...owner, sessionId: "local-2" },
      async () => result, async () => sent, 0)
    next.receive({ ...request(), owner: { ...owner, sessionId: "local-2" } })
    await next.idle()
    expect(next.runs).toBe(1)
  })

for (const [receipt, delivery] of [
  [sent, "sent"],
  [{ transmission: "sent", acknowledgment: "unknown" }, "uncertain"],
  [{ transmission: "unknown", acknowledgment: "unknown" }, "uncertain"],
  [{ transmission: "not_sent", acknowledgment: "unavailable" }, "not_sent"],
  [{ transmission: "sent", acknowledgment: "acknowledged" }, "acknowledged"],
] as const) {
  test(`completion receipt ${JSON.stringify(receipt)} is not overstated`,
    async () => {
      let calls = 0
      const c = new Coordinator(owner, async () => result,
        async () => { calls++; return receipt }, 0)
      c.receive(request())
      await c.idle()
      c.receive(request())
      expect(calls).toBe(1)
      expect(c.diagnostics()[0].delivery).toBe(delivery)
      expect(c.historyContext().tasks[0].resolution)
        .toEqual({ outcome: "completed", delivery })
    })
}

test("a resolved void send is never interpreted as acknowledgment",
  async () => {
    const c = new Coordinator(owner, async () => result,
      // Simulate an incorrectly implemented external adapter.
      async () => undefined as unknown as DeliveryReceipt, 0)
    c.receive(request())
    await c.idle()
    expect(c.diagnostics()[0].delivery).toBe("uncertain")
  })

test("invalid task bytes reject once without invoking the backend",
  async () => {
    const completions: Completion[] = []
    const c = new Coordinator(owner, async () => {
      throw new Error("must not run")
    }, async completion => { completions.push(completion); return sent }, 0)
    for (const [n, task] of ["", " \n ", "😀".repeat(MAX_TASK_BYTES / 4 + 1)]
      .entries()) c.receive(request(`invalid-${n}`, task))
    c.receive(request("invalid-0", "now valid"))
    await c.idle()
    expect(c.runs).toBe(0)
    expect(completions.map(c => c.outcome))
      .toEqual(["rejected", "rejected", "rejected"])
    expect(completions.every(c => !("summary" in c))).toBe(true)
  })

test("queue rejection, expiry and supersession all complete once",
  async () => {
    let now = 0
    let release: (() => void) | undefined
    const completions: Completion[] = []
    const c = new Coordinator(owner, async () => {
      await new Promise<void>(resolve => { release = resolve })
      return result
    }, async completion => { completions.push(completion); return sent }, {
      settleMs: 0, queueMs: 10, now: () => now,
    })
    c.receive(request())
    await until(() => !!release)
    for (let n = 2; n <= 6; n++) c.receive(request(`call-${n}`))
    now = 20
    release!()
    await c.idle()
    expect(c.runs).toBe(1)
    expect(completions.map(c => c.outcome)).toEqual([
      "rejected", "superseded", "expired", "expired", "expired", "expired",
    ])
    expect(new Set(completions.map(c => c.requestId)).size).toBe(6)
    expect(c.historyContext().tasks[0]).toMatchObject({
      outcome: "completed", delivery: "withheld", result,
      resolution: { outcome: "superseded", delivery: "sent" },
    })
  })

test("cancellation settles active and queued requests without late results",
  async () => {
    const completions: Completion[] = []
    let running = false
    const c = new Coordinator(owner, async (_context, signal) => {
      running = true
      await new Promise<void>(resolve => {
        signal.addEventListener("abort", () => resolve(), { once: true })
      })
      return result
    }, async completion => { completions.push(completion); return sent }, 0)
    c.receive(request())
    await until(() => running)
    c.receive(request("call-2"))
    c.cancel()
    c.cancel()
    await c.idle()
    expect(completions.map(c => [c.requestId, c.outcome])).toEqual([
      ["call-2", "cancelled"], ["call-1", "cancelled"],
    ])
    expect(c.diagnostics().every(t => t.outcome === "cancelled")).toBe(true)
    expect(completions.every(c => !("summary" in c))).toBe(true)
  })

test("pending no-work responses keep the coordinator busy until settled",
  async () => {
    let finish: ((receipt: DeliveryReceipt) => void) | undefined
    const c = new Coordinator(owner, async () => result,
      () => new Promise(resolve => { finish = resolve }), 0)
    c.receive(request("invalid", ""))
    expect(c.busy).toBe(true)
    finish!(sent)
    await c.idle()
    expect(c.busy).toBe(false)
  })

test("OpenAI completion waits for correlated append acknowledgment",
  async () => {
    const wire: any[] = []
    const client = new LiveClient({ send: raw => wire.push(JSON.parse(raw)) })
    const openAI: Owner = { provider: "openai", sessionId: "s",
      sessionIdSource: "provider" }
    const complete = openAIComplete(openAI, client)
    let settled = false
    const receipt = complete({ owner: openAI, requestId: "d",
      outcome: "completed", summary: "answer" }).then(value => {
        settled = true
        return value
      })
    client.receive(JSON.stringify({ type: "session.commentary.appended",
      client_event_id: "unrelated" }))
    await Bun.sleep(1)
    expect(settled).toBe(false)
    client.receive(JSON.stringify({ type: "session.commentary.appended",
      client_event_id: wire[0].event_id }))
    expect(await receipt).toEqual({
      transmission: "sent", acknowledgment: "acknowledged",
    })
    for (const outcome of [
      "rejected", "expired", "cancelled", "superseded",
    ] as const) {
      expect(await complete({ owner: openAI, requestId: "d", outcome }))
        .toEqual({ transmission: "not_sent", acknowledgment: "unavailable" })
    }
    expect(wire).toHaveLength(1)
    await expect(complete({ owner, requestId: "d", outcome: "cancelled" }))
      .rejects.toThrow("owner")
    client.disconnect()
  })

test("OpenAI transcript mapping retains wire time, whitespace and identity",
  () => {
    const wire = { type: "session.input_transcript.delta" as const,
      event_id: "e1", delta: " no no\n", start_ms: 1, end_ms: 5 }
    expect(openAIObservation("s", wire)).toMatchObject({
      type: "transcript", text: " no no\n", speaker: "user",
      identity: "id:e1", media: { startMs: 1, endMs: 5 },
      owner: { provider: "openai", sessionIdSource: "provider" },
    })
    expect(openAIObservation("s", { type: "session.delegation.created",
      offset_ms: 0,
      delegation: { id: "d", type: "delegation", target: "responses" },
    })).toBeNull()
  })

test("transport closure, remote end and usage finality are independent",
  () => {
    const state = new Lifecycle()
    state.observe({
      transport: "closed", remote: "unknown", usage: "partial",
    })
    expect(state.snapshot()).toEqual({
      transport: "closed", remote: "unknown", usage: "partial",
    })
    state.observe({ transport: "open", remote: "ended", usage: "unknown" })
    expect(state.snapshot()).toEqual({
      transport: "closed", remote: "ended", usage: "partial",
    })
    state.observe({ transport: "open", remote: "unknown", usage: "final" })
    state.observe({ transport: "open", remote: "unknown", usage: "partial" })
    expect(state.snapshot().usage).toBe("final")
  })

test("OpenAI adapter maps terminal usage without treating it as socket close",
  async () => {
    const events: ProviderObservation[] = []
    const connect = openAIProvider(async (_sdp, receive) => {
      receive({ type: "session.started", session: { id: "s" } })
      return { id: "s", sdp: "answer",
        client: new LiveClient({ send() {} }),
        async close() {
          receive({ type: "session.closed", session: { id: "s" },
            usage: { seconds: 12 }, reason: "client_request" })
          return true
        } }
    })
    const session = await connect("offer", e => events.push(e), () => {},
      new AbortController().signal)
    expect(events[0].type).toBe("started")
    expect(await session.close()).toEqual({
      transport: "closed", remote: "ended", usage: "final",
    })
    expect(events.at(-1)).toMatchObject({ type: "lifecycle", state: {
      transport: "open", remote: "ended", usage: "final",
    } })
    expect(events.at(-2)).toMatchObject({ type: "usage",
      unit: "seconds", seconds: 12, completeness: "final" })
  })

test("checkpoint merging reads legacy ownership without cross-provider loss",
  () => {
    const old: HistoryContext = { version: 1,
      conversationId: crypto.randomUUID(), incomplete: false,
      fragments: [{ sessionId: "s", sequence: 1,
        speaker: "user", text: "old" }], tasks: [] }
    const current: HistoryContext = { ...old, fragments: [{
      provider: "gemini", sessionIdSource: "local", sessionId: "s",
      sequence: 1, speaker: "user", text: "new",
    }] }
    const merged = mergeHistory(old, current)
    expect(merged.fragments.map(f => f.text)).toEqual(["old", "new"])
    expect(mergeHistory(merged, current).fragments).toHaveLength(2)
  })

test("model selection defaults to OpenAI; Gemini preview preserves voices",
  () => {
    expect(parseArgs(["-f", "seed"]).model).toBe("gpt-live-1")
    expect(parseArgs(["--model", "gpt-live-1", "-f", "seed"]).model)
      .toBe("gpt-live-1")
    expect(() => parseArgs(["-f", "seed", "--model", "unknown"]))
      .toThrow("Unsupported Live model")
    expect(parseArgs(["-f", "seed", "--voice", "Kore",
      "--model", "gemini-3.8-live"]).voice).toBe("Kore")
    expect(() => parseArgs(["-f", "seed", "--voice", "Kore"]))
      .toThrow("Invalid provider voice")
    expect(() => parseArgs(["-f", "seed", "--model", "gemini-3.8-live",
      "--resume", "a".repeat(36)])).toThrow("resume is not enabled")
  })

test("controller does not finalize usage from a neutral transport close",
  async () => {
    const server = startServer({
      backend: async () => result,
      connect: async () => ({ owner, media: { kind: "webrtc", sdp: "answer" },
        complete: async () => sent, bootstrap: () => [],
        close: async () => ({
          transport: "closed", remote: "ended", usage: "partial",
        }) }),
    })
    const post = (path: string, body = {}) => fetch(server.origin + path, {
      method: "POST", body: JSON.stringify(body), headers: {
        Origin: server.origin, Authorization: `Bearer ${server.secret}`,
        "Content-Type": "application/json",
      },
    })
    try {
      expect((await post("/start", { sdp: "offer" })).status).toBe(200)
      expect(await (await post("/end")).json())
        .toEqual({ ok: true, confirmed: false })
      const state = await (await post("/state")).json()
      expect(state.lifecycle).toEqual({
        transport: "closed", remote: "ended", usage: "partial",
      })
      expect(state.usage.final).toBe(false)
      expect(state.phase).toContain("unconfirmed")
    } finally { await server.stop() }
  })

test("controller ignores interim identities but retains repeated normal text",
  async () => {
    let receive!: (event: ProviderObservation) => void
    const server = startServer({ backend: async () => result,
      connect: async (_sdp, onEvent) => {
        receive = onEvent
        return { owner, media: { kind: "webrtc", sdp: "answer" },
          complete: async () => sent, bootstrap: () => [],
          close: async () => ({
            transport: "closed", remote: "unknown", usage: "unknown",
          }) }
      } })
    const post = (path: string, body = {}) => fetch(server.origin + path, {
      method: "POST", body: JSON.stringify(body), headers: {
        Origin: server.origin, Authorization: `Bearer ${server.secret}`,
        "Content-Type": "application/json",
      },
    })
    try {
      await post("/start", { sdp: "offer" })
      receive({ ...speech("discard"), interim: true, identity: "fragment" })
      receive({ ...speech(" no"), identity: "fragment" })
      receive(speech(" no"))
      const state = await (await post("/state")).json()
      expect(state.captions.map((f: { text: string }) => f.text))
        .toEqual([" no", " no"])
      expect(state.runs).toBe(0)
    } finally { await server.stop() }
  })

test("OpenAI multipart results preserve Unicode and await every append",
  async () => {
    const owner: Owner = { provider: "openai", sessionId: "s",
      sessionIdSource: "provider" }
    const wire: any[] = []
    const client = new LiveClient({ send: raw => wire.push(JSON.parse(raw)) })
    const summary = "雪🙂 abc\n".repeat(1000)
    let settled = false
    const pending = openAIComplete(owner, client)({ owner, requestId: "d",
      outcome: "completed", summary }).then(receipt => {
        settled = true
        return receipt
      })
    const total = Number(wire[0].content.match(/part 1\/(\d+)/)[1])
    for (let index = 0; index < total; index++) {
      expect(settled).toBe(false)
      expect(wire).toHaveLength(index + 1)
      expect(Buffer.byteLength(wire[index].content)).toBeLessThanOrEqual(400)
      expect(wire[index].delegation_id).toBe("d")
      client.receive(JSON.stringify({ type: "session.commentary.appended",
        client_event_id: wire[index].event_id }))
      await Bun.sleep(0)
    }
    expect(await pending).toEqual({ transmission: "sent",
      acknowledgment: "acknowledged" })
    expect(wire.map(w => w.content.replace(/^[^\n]+\n/, "")).join(""))
      .toBe(summary)
    client.disconnect()
  })

test("a rejected multipart append stops without retries", async () => {
  const owner: Owner = { provider: "openai", sessionId: "s",
    sessionIdSource: "provider" }
  const wire: any[] = []
  const client = new LiveClient({ send: raw => wire.push(JSON.parse(raw)) })
  const pending = openAIComplete(owner, client)({ owner, requestId: "d",
    outcome: "completed", summary: "x".repeat(2000) })
  client.receive(JSON.stringify({ type: "error", error: {
    message: "Rejected", code: null, client_event_id: wire[0].event_id,
  } }))
  await expect(pending).rejects.toThrow("rejected")
  expect(wire).toHaveLength(1)
  client.disconnect()
})
