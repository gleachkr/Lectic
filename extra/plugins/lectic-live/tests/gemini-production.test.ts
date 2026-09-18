import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { History, loadHistory, type HistoryContext } from "../history"
import { workspace } from "./helpers"
import type { ContextEnvelope } from "../transcript"
import { MAX_RESULT_BYTES } from "../result"
import { expect, test } from "bun:test"
import { connect as netConnect } from "node:net"
import { geminiConnector, geminiSetup, type GeminiSocket } from "../gemini"
import { sendPCM } from "../pcm-relay"
import type { PCMOutput, ProviderObservation } from "../provider"
import { startServer, type ServerOptions } from "../server"
import { toolResult } from "../gemini-wire"

async function until(check: () => boolean) {
  const deadline = Date.now() + 2000
  while (!check()) {
    if (Date.now() > deadline) throw new Error("Test wait expired")
    await Bun.sleep(2)
  }
}
function fakeSocket() {
  const wires: any[] = []
  let closes = 0
  const socket: GeminiSocket = {
    readyState: 1, bufferedAmount: 0,
    send: raw => { wires.push(JSON.parse(raw)) },
    close: () => {
      closes++
      socket.readyState = 3
      socket.onclose?.()
    },
    onopen: null, onmessage: null, onerror: null, onclose: null,
  }
  const message = (value: unknown) => socket.onmessage?.({
    data: JSON.stringify(value),
  })
  return { socket, wires, message, closes: () => closes }
}
function adapter(timeout = 100) {
  const f = fakeSocket()
  const events: ProviderObservation[] = []
  const output: PCMOutput[] = []
  const abort = new AbortController()
  let lost = 0
  const connect = geminiConnector("never-used-key", "Kore",
    () => f.socket, timeout)
  const pending = connect("", event => events.push(event), () => { lost++ },
    abort.signal)
  void pending.catch(() => {})
  const setup = () => {
    f.socket.onopen!()
    f.message({ setupComplete: {} })
  }
  async function ready() {
    setup()
    const session = await pending
    if (session.media.kind !== "pcm") throw new Error("Expected PCM")
    session.media.attach(value => output.push(value))
    return { session, media: session.media }
  }
  return { ...f, events, output, abort, pending, setup, ready,
    lost: () => lost }
}

test("production setup has only non-blocking delegate, without resumption",
  () => {
    const value = geminiSetup("Aoede").setup
    expect(value.generationConfig.speechConfig.voiceConfig
      .prebuiltVoiceConfig.voiceName).toBe("Aoede")
    expect(value.tools[0].functionDeclarations).toHaveLength(1)
    expect(value.tools[0].functionDeclarations[0]).toMatchObject({
      name: "delegate", behavior: "NON_BLOCKING",
    })
    expect(value).not.toHaveProperty("historyConfig")
    expect(value).not.toHaveProperty("sessionResumption")
    expect(value).not.toHaveProperty("store")
    expect(() => geminiSetup("kore")).toThrow("Invalid Gemini voice")
    expect(() => geminiSetup("Kore\nsecret")).toThrow()
    expect(toolResult("call", "done").toolResponse.functionResponses[0])
      .toMatchObject({ scheduling: "WHEN_IDLE", willContinue: false })
    expect(() => toolResult("", "done")).toThrow()
    expect(() => toolResult("call", "x".repeat(MAX_RESULT_BYTES + 33)))
      .toThrow()
  })

for (const rate of [44100, 48000]) {
  test(`production adapter relays native ${rate} PCM and exact observations`,
    async () => {
      const a = adapter()
      const { session, media } = await a.ready()
      expect(session.owner).toMatchObject({
        provider: "gemini", sessionIdSource: "local",
      })
      const frame = new Uint8Array(rate * .02 * 2)
      frame.set([0, 128, 255, 127])
      media.capture(frame, rate)
      expect(a.wires[1]).toEqual({ realtimeInput: { audio: {
        mimeType: `audio/pcm;rate=${rate}`,
        data: Buffer.from(frame).toString("base64"),
      } } })
      a.message({ serverContent: { inputTranscription: { text: " no" },
        interimInputTranscription: "ignored", outputTranscription: {
          text: " yes\n",
        } } })
      a.message({ serverContent: { inputTranscription: { text: " no" } } })
      expect(a.events.filter(e => e.type === "transcript")
        .map(e => e.text)).toEqual([" no", " yes\n", " no"])
      expect(a.events[1]).not.toHaveProperty("media")
      const modelTurn = { parts: [{ inlineData: {
        mimeType: "audio/pcm;rate=24000", data: "AIAAfg==",
      } }] }
      a.message({ serverContent: { modelTurn } })
      expect(a.output[0]).toEqual(Buffer.from("AIAAfg==", "base64"))
      a.message({ serverContent: { modelTurn, interrupted: true } })
      expect(a.output).toHaveLength(2)
      expect(a.output[1]).toBe("flush")
      a.message({ usageMetadata: { totalTokenCount: 22 } })
      expect(a.events.at(-1)).toMatchObject({ type: "usage", unit: "tokens",
        completeness: "partial", counters: { totalTokenCount: 22 } })
      expect(await session.close()).toEqual({ transport: "closed",
        remote: "unknown", usage: "partial" })
      expect(a.lost()).toBe(0)
      expect(a.closes()).toBe(1)
      await session.close()
      expect(a.closes()).toBe(1)
    })
}

for (const mode of ["timeout", "abort", "close", "error", "malformed",
  "oversized", "invalidUtf8", "premature", "duplicateOpen"]) {
  test(`Gemini startup ${mode} is bounded, redacted and never retried`,
    async () => {
      const a = adapter(10)
      const lateOpen = a.socket.onopen!
      const lateMessage = a.socket.onmessage!
      if (mode === "abort") a.abort.abort()
      if (mode === "close") a.socket.onclose!()
      if (mode === "error") a.socket.onerror!()
      if (mode === "malformed") a.message({ error: { secret: "private" } })
      if (mode === "oversized") {
        a.socket.onmessage!({ data: "private".repeat(100000) })
      }
      if (mode === "invalidUtf8") {
        a.socket.onmessage!({ data: new Uint8Array([255]) })
      }
      if (mode === "premature") a.message({ serverContent: {
        inputTranscription: { text: "private" },
      } })
      if (mode === "duplicateOpen") { lateOpen(); lateOpen() }
      await expect(a.pending).rejects.toThrow("Gemini")
      const sent = a.wires.length
      lateOpen()
      lateMessage({ data: '{"setupComplete":{}}' })
      expect(a.wires).toHaveLength(sent)
      expect(a.events).toEqual([])
      expect(a.lost()).toBe(0)
    })
}

for (const mode of ["goAway", "error", "close", "tool", "duplicateSetup",
  "inputSize", "providerBackpressure", "sendFailure", "outputFailure"]) {
  test(`active Gemini ${mode} stops once, without replay or false finality`,
    async () => {
      const a = adapter()
      const { session, media } = await a.ready()
      const lateMessage = a.socket.onmessage!
      if (mode === "goAway") a.message({ goAway: { timeLeft: "30s" },
        usageMetadata: { totalTokenCount: 7 } })
      if (mode === "error") a.socket.onerror!()
      if (mode === "close") a.socket.onclose!()
      if (mode === "duplicateSetup") a.message({ setupComplete: {} })
      if (mode === "tool") a.message({ toolCall: { functionCalls: [{
        name: "unknown", id: "c", args: { task: "must not execute" },
      }] } })
      if (mode === "inputSize") {
        expect(() => media.capture(new Uint8Array(1), 48000)).toThrow()
      }
      if (mode === "providerBackpressure" || mode === "sendFailure") {
        if (mode === "providerBackpressure") a.socket.bufferedAmount = 255999
        else a.socket.send = () => { throw new Error("private raw URL") }
        expect(() => media.capture(new Uint8Array(1920), 48000)).toThrow()
      }
      if (mode === "outputFailure") {
        // Use the actual bounded relay as the failed media consumer.
        a.output.push = () => { sendPCM(undefined, "flush", true); return 0 }
        a.message({ serverContent: { interrupted: true } })
      }
      expect(a.lost()).toBe(1)
      lateMessage({ data: '{"serverContent":{"inputTranscription":'
        + '{"text":"retired"}}}' })
      const state = await session.close()
      expect(state.remote).toBe("unknown")
      expect(state.usage).toBe(mode === "goAway" ? "partial" : "unknown")
      if (mode === "goAway") {
        expect(a.events.at(-1)).toMatchObject({ type: "error",
          owner: session.owner, reason: "provider_limit" })
      }
      expect(a.events.some(e => e.type === "request")).toBe(false)
      expect(JSON.stringify(a.events)).not.toMatch(/private|retired/)
      expect(a.wires).toHaveLength(1)
      expect(a.closes()).toBe(1)
    })
}

test("PCM output queue enforces readiness, size, pressure and send outcomes",
  () => {
    const sent: unknown[] = []
    const socket = { readyState: 1, getBufferedAmount: () => 0,
      send(data: unknown) { sent.push(data); return 1 } }
    sendPCM(socket, new Uint8Array(2), true)
    sendPCM(socket, "flush", false)
    expect(sent).toHaveLength(2)
    expect(() => sendPCM(socket, new Uint8Array(2), false)).toThrow()
    expect(() => sendPCM(socket, new Uint8Array(192001), true)).toThrow()
    expect(() => sendPCM({ ...socket, getBufferedAmount: () => 191999 },
      new Uint8Array(2), true)).toThrow()
    expect(() => sendPCM({ ...socket, send: () => 0 }, "flush", true))
      .toThrow()
    expect(() => sendPCM({ ...socket, readyState: 3 }, "flush", true))
      .toThrow()
    // Bun -1 means queued, not failed; the bound already includes this frame.
    expect(() => sendPCM({ ...socket, send: () => -1 }, "flush", true))
      .not.toThrow()
  })

function controller(options: Partial<ServerOptions> = {}) {
  const f = fakeSocket()
  let connects = 0
  let runs = 0
  const server = startServer({ provider: "gemini",
    connect: geminiConnector("never-used", undefined, () => {
      connects++
      f.socket.readyState = 1
      f.socket.bufferedAmount = 0
      return f.socket
    }),
    backend: async () => { runs++; return { status: "completed",
      summary: "must not run" } }, ...options,
  })
  const post = (path: string, body = {}) => fetch(server.origin + path, {
    method: "POST", body: JSON.stringify(body), headers: {
      Origin: server.origin, Authorization: `Bearer ${server.secret}`,
      "Content-Type": "application/json",
    },
  })
  async function browser(secret = server.secret, origin = server.origin) {
    const Socket = WebSocket as unknown as {
      new(url: string, options: Bun.WebSocketOptions): WebSocket
    }
    const ws = new Socket(server.origin.replace("http:", "ws:") + "/socket", {
      protocols: ["lectic-live-pcm", `auth.${secret}`],
      headers: { Origin: origin },
    })
    ws.binaryType = "arraybuffer"
    const output: unknown[] = []
    let failed = false
    ws.onmessage = event => output.push(event.data)
    ws.onerror = () => { failed = true }
    await until(() => ws.readyState === 1 || ws.readyState === 3 || failed)
    return { ws, output }
  }
  async function ready(rate = 48000) {
    const b = await browser()
    const starting = post("/start", { rate })
    await until(() => connects === 1)
    f.socket.onopen!()
    f.message({ setupComplete: {} })
    const response = await starting
    expect(response.status).toBe(200)
    const info = await response.json()
    expect(info).not.toHaveProperty("sdp")
    expect((await post("/ready", { events: [] })).status).toBe(200)
    return { ...b, info }
  }
  return { ...f, server, post, browser, ready,
    connects: () => connects, runs: () => runs,
    state: async () => (await post("/state")).json() }
}

test("production PCM upgrade uses private handoff and one active owner",
  async () => {
    const h = controller()
    try {
      expect((await h.post("/start", { rate: 48000 })).status).toBe(400)
      for (const [secret, origin] of [["bad", h.server.origin],
        [h.server.secret, "https://evil.invalid"], [h.server.secret, ""]]) {
        expect((await h.browser(secret, origin)).ws.readyState).not.toBe(1)
      }
      expect((await fetch(h.server.origin, {
        headers: { Host: "evil.invalid" },
      })).status).toBe(403)
      expect(h.connects()).toBe(0)
      const b = await h.ready(44100)
      expect((await h.browser()).ws.readyState).not.toBe(1)
      b.ws.send(new Uint8Array(1764))
      await until(() => h.wires.length === 2)
      expect(h.wires[1].realtimeInput.audio.mimeType)
        .toBe("audio/pcm;rate=44100")
      h.message({ serverContent: { modelTurn: { parts: [{ inlineData: {
        mimeType: "audio/pcm;rate=24000", data: "AAAAAA==",
      } }] } } })
      h.message({ serverContent: { interrupted: true } })
      await until(() => b.output.length === 2)
      expect(b.output[0]).toBeInstanceOf(ArrayBuffer)
      expect(b.output[1]).toBe('{"type":"flush"}')
      b.ws.close()
      await until(() => h.closes() === 1)
      expect((await h.state()).sleeping).toBe(true)
      expect(h.connects()).toBe(1)
      expect(h.runs()).toBe(0)
    } finally { await h.server.stop() }
  })

for (const bad of [new Uint8Array(2), "{}", "x".repeat(9000)]) {
  test("production local frames before readiness cannot create sessions",
    async () => {
      const h = controller()
      try {
        const b = await h.browser()
        b.ws.send(bad)
        await until(() => b.ws.readyState === 3)
        expect(h.connects()).toBe(0)
        expect(h.runs()).toBe(0)
      } finally { await h.server.stop() }
    })
}

test("closing PCM browser during startup cancels late provider attachment",
  async () => {
    const h = controller()
    try {
      const b = await h.browser()
      const pending = h.post("/start", { rate: 48000 })
      await until(() => h.connects() === 1)
      const open = h.socket.onopen!
      const message = h.socket.onmessage!
      b.ws.close()
      expect((await pending).status).toBe(502)
      open()
      message({ data: '{"setupComplete":{}}' })
      expect(h.wires).toHaveLength(0)
      expect((await h.state()).ending).toBe(true)
    } finally { await h.server.stop() }
  })

for (const mode of ["invalidFrame", "oversized", "forged", "heartbeat",
  "budget"]) {
  test(`production ${mode} is terminal; no OpenAI minimum or automatic wake`,
    async () => {
      const h = controller({
        maxSessionSeconds: 1, watchdogMs: 5,
        heartbeatMs: mode === "heartbeat" ? 30 : 10000,
      })
      try {
        const b = await h.ready()
        h.message({ usageMetadata: { totalTokenCount: 100 } })
        h.message({ usageMetadata: { totalTokenCount: 5 } })
        const state = await h.state()
        expect(state.ending).toBe(false)
        expect(state.usage).toMatchObject({ unit: "tokens",
          latest: { totalTokenCount: 5 }, final: false })
        expect(state.usage).not.toHaveProperty("estimatedBillableSeconds")
        if (mode === "invalidFrame") b.ws.send(new Uint8Array(1918))
        if (mode === "oversized") b.ws.send(new Uint8Array(9000))
        if (mode === "forged") b.ws.send('{"toolResponse":{}}')
        await until(() => h.closes() === 1)
        if (mode === "heartbeat") {
          await h.server.stopped
          await expect(h.state()).rejects.toThrow()
        } else {
          expect((await h.state()).ending).toBe(true)
          expect((await h.state()).sleeping).toBe(false)
          expect((await h.post("/start", { rate: 48000 })).status).toBe(409)
        }
        expect(h.connects()).toBe(1)
        expect(h.runs()).toBe(0)
      } finally { await h.server.stop() }
    })
}

// Bun 1.3's client protocol getter can return corrupt text after failed
// upgrades. Assert the actual HTTP response, not that borrowed getter.
test("upgrade negotiates only the public protocol, never the credential",
  async () => {
    const h = controller()
    try {
      const url = new URL(h.server.origin)
      const response = await new Promise<string>((resolve, reject) => {
        const socket = netConnect(Number(url.port), url.hostname, () => {
          socket.write([
            "GET /socket HTTP/1.1", `Host: ${url.host}`,
            "Connection: Upgrade", "Upgrade: websocket",
            "Sec-WebSocket-Version: 13",
            "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
            `Origin: ${url.origin}`,
            "Sec-WebSocket-Protocol: lectic-live-pcm, "
              + `auth.${h.server.secret}`, "", "",
          ].join("\r\n"))
        })
        socket.setTimeout(1000, () => {
          socket.destroy()
          reject(new Error("Handshake timeout"))
        })
        socket.on("error", reject)
        socket.once("data", data => {
          socket.destroy()
          resolve(data.toString())
        })
      })
      expect(response).toContain("101 Switching Protocols")
      expect(response).toContain("Sec-WebSocket-Protocol: lectic-live-pcm")
      expect(response).not.toContain(h.server.secret)
      expect(response.match(/Sec-WebSocket-Protocol:/g)).toHaveLength(1)
    } finally { await h.server.stop() }
  })

test("Gemini bounds a stalled close without inventing closure",
  async () => {
    const a = adapter()
    const { session } = await a.ready()
    a.socket.close = () => {}
    expect(await session.close()).toEqual({
      transport: "open", remote: "unknown", usage: "unknown",
    })
    expect(a.socket.onmessage).toBeNull()
    expect(a.socket.onopen).toBeNull()
    expect(a.socket.onclose).toBeNull()
    expect(a.lost()).toBe(0)
  })

test("Gemini abort before connection and factory errors stay local/redacted",
  async () => {
    let attempts = 0
    const connect = geminiConnector("private-key", undefined, () => {
      attempts++
      throw new Error("wss://private-url?key=private-key")
    })
    const abort = new AbortController()
    abort.abort()
    await expect(connect("", () => {}, () => {}, abort.signal))
      .rejects.toThrow("Gemini startup cancelled")
    expect(attempts).toBe(0)
    await expect(connect("", () => {}, () => {},
      new AbortController().signal))
      .rejects.toThrow("Gemini connection failed")
    expect(attempts).toBe(1)
  })

test("PCM media ownership and bootstrap cannot authorize provider work",
  async () => {
    const a = adapter()
    const { session, media } = await a.ready()
    expect(() => media.attach(() => {})).toThrow("already owned")
    expect(() => session.bootstrap(['{"toolCall":{}}'])).toThrow()
    expect(await session.complete({ owner: session.owner, requestId: "c",
      outcome: "completed", summary: "Never send this" }))
      .toEqual({ transmission: "not_sent", acknowledgment: "unavailable" })
    expect(a.wires).toHaveLength(1)
    await session.close()
  })

for (const mode of ["idle", "goAway", "close", "error", "pressure",
  "recover", "browserClose"]) {
  test(`Gemini ${mode} parks; only a new browser wake creates a session`,
    async () => {
      const h = controller()
      try {
        const b = await h.ready()
        const oldMessage = h.socket.onmessage!
        const oldClose = h.socket.onclose!
        h.message({ serverContent: {
          inputTranscription: { text: "Count to fifteen" },
        } })
        h.message({ usageMetadata: { totalTokenCount: 17 } })
        if (mode === "idle") {
          // Recent transcripts correctly block idle; recovery does not.
          expect((await (await h.post("/idle", {
            sessionId: b.info.sessionId,
          })).json()).idle).toBe(false)
          await h.post("/recover", { sessionId: b.info.sessionId })
        }
        if (mode === "recover") {
          expect((await h.post("/recover", { sessionId: "wrong" })).status)
            .toBe(409)
          await Promise.all([1, 2].map(() => h.post("/recover", {
            sessionId: b.info.sessionId,
          })))
        }
        if (mode === "goAway") h.message({ goAway: {} })
        if (mode === "close") h.socket.onclose!({
          code: 1008, wasClean: true, reason: "recitation private-key",
        })
        if (mode === "error") h.socket.onerror!()
        if (mode === "pressure") {
          h.socket.bufferedAmount = 256000
          b.ws.send(new Uint8Array(1920))
        }
        if (mode === "browserClose") b.ws.close()
        await until(() => h.closes() === 1)
        const parked = await h.state()
        expect(parked.sleeping).toBe(true)
        expect(parked.ending).toBe(false)
        expect(parked.confirmed).toBe(false)
        expect(parked.lifecycle).toEqual({ transport: "closed",
          remote: "unknown", usage: "partial" })
        expect(parked.usage.latest).toEqual({ totalTokenCount: 17 })
        expect(h.connects()).toBe(1)
        if (mode === "close") {
          expect(JSON.stringify(parked.diagnostics)).toContain("recitation")
          expect(JSON.stringify(parked.diagnostics)).not.toContain("private")
          expect(parked.diagnostics.find((e: any) => e.detail)?.detail)
            .toMatchObject({ closeCode: 1008, wasClean: true })
        }
        const next = await h.browser()
        expect(next.ws.readyState).toBe(1)
        const pending = h.post("/start", { rate: 44100 })
        await until(() => h.connects() === 2)
        h.socket.onopen!()
        h.message({ setupComplete: {} })
        const response = await pending
        expect(response.status).toBe(200)
        const info = await response.json()
        expect(info.sessionId).not.toBe(b.info.sessionId)
        expect((await h.post("/ready", { events: [] })).status).toBe(200)
        const seed = h.wires.find(w => w.clientContent)
        expect(seed.clientContent.turnComplete).toBe(true)
        expect(h.wires.filter(w => w.setup).at(-1).setup.historyConfig)
          .toEqual({ initialHistoryInClientContent: true })
        expect(JSON.stringify(seed)).toContain("Count to fifteen")
        expect(h.wires.filter(w => w.realtimeInput)).toHaveLength(0)
        oldMessage({ data: '{"serverContent":{"inputTranscription":'
          + '{"text":"retired"}}}' })
        oldClose()
        const active = await h.state()
        expect(active.ready).toBe(true)
        expect(active.ending).toBe(false)
        expect(active.usage.previous).toEqual([{
          latest: { totalTokenCount: 17 }, lifecycle: parked.lifecycle,
        }])
        expect(active.usage.latest).toBeUndefined()
        expect(active.elapsed).toBeGreaterThanOrEqual(parked.elapsed)
        expect(JSON.stringify(active.captions)).not.toContain("retired")
        expect(h.runs()).toBe(0)
        await h.post("/end")
        expect((await h.post("/recover", { sessionId: info.sessionId }))
          .status).toBe(409)
        expect((await h.browser()).ws.readyState).not.toBe(1)
      } finally { await h.server.stop() }
    })
}

test("Gemini idle wakes without requiring OpenAI's minimum or final usage",
  async () => {
    const h = controller({ maxSessionSeconds: 10 })
    try {
      const b = await h.ready()
      expect(await (await h.post("/idle", {
        sessionId: b.info.sessionId,
      })).json()).toEqual({ idle: true })
      expect((await h.state()).sleeping).toBe(true)
      await h.browser()
      const pending = h.post("/start", { rate: 48000 })
      await until(() => h.connects() === 2)
      h.socket.onopen!()
      h.message({ setupComplete: {} })
      expect((await pending).status).toBe(200)
    } finally { await h.server.stop() }
  })

test("Gemini uncertain transport closure forbids recovery", async () => {
  const h = controller()
  try {
    const b = await h.ready()
    h.socket.close = () => {}
    expect(await (await h.post("/recover", {
      sessionId: b.info.sessionId,
    })).json()).toEqual({ idle: false })
    expect((await h.state()).ending).toBe(true)
    expect((await h.state()).sleeping).toBe(false)
    expect((await h.browser()).ws.readyState).not.toBe(1)
    expect(h.connects()).toBe(1)
  } finally { await h.server.stop() }
})

test("provider turn rejection is diagnostic, not a forced shutdown",
  async () => {
    const a = adapter()
    const { session } = await a.ready()
    for (const reason of ["RESPONSE_REJECTED", "private-payload"]) {
      a.message({ serverContent: { turnComplete: true,
        turnCompleteReason: reason } })
    }
    expect(a.events.filter(e => e.type === "diagnostic")
      .map(e => e.detail.code)).toEqual([
      "RESPONSE_REJECTED", "OTHER_TURN_REASON",
    ])
    expect(a.lost()).toBe(0)
    expect(JSON.stringify(a.events)).not.toContain("private-payload")
    a.message({ serverContent: { modelTurn: { parts: [{ inlineData: {
      mimeType: "wrong-private", data: "AAAA",
    } }] } } })
    expect(a.events.at(-1)).toMatchObject({ type: "error", detail: {
      source: "protocol", code: "Invalid audio MIME",
    } })
    expect(a.lost()).toBe(1)
    await session.close()
  })

test("Gemini connected-time cap survives wakes and excludes parked time",
  async () => {
    const h = controller({ maxSessionSeconds: 1, watchdogMs: 5 })
    try {
      const first = await h.ready()
      await Bun.sleep(550)
      await h.post("/recover", { sessionId: first.info.sessionId })
      const parked = await h.state()
      await Bun.sleep(550)
      expect((await h.state()).elapsed).toBe(parked.elapsed)
      expect((await h.state()).ending).toBe(false)
      await h.browser()
      const pending = h.post("/start", { rate: 48000 })
      await until(() => h.connects() === 2)
      h.socket.onopen!()
      h.message({ setupComplete: {} })
      const info = await (await pending).json()
      await h.post("/ready", { events: [] })
      // Total connected time, not just the replacement's time, hits 1s.
      await Bun.sleep(550)
      const ended = await h.state()
      expect(ended.ending).toBe(true)
      expect(ended.diagnostics.map((e: any) => e.code))
        .toContain("budget_reached")
      expect((await h.post("/recover", { sessionId: info.sessionId })).status)
        .toBe(409)
      expect(h.connects()).toBe(2)
    } finally { await h.server.stop() }
  })

test("controller routes Gemini calls/cancellation and blocks busy idle",
  async () => {
    let signal: AbortSignal | undefined
    let runs = 0
    const h = controller({ backend: async (_context, s) => {
      runs++
      signal = s
      await new Promise<void>(done => {
        s.addEventListener("abort", () => done(), { once: true })
      })
      return { status: "completed", summary: "A write finished before abort" }
    } })
    try {
      const b = await h.ready()
      h.message({ toolCall: { functionCalls: [{
        id: "a", name: "delegate", args: { task: "Write A once" },
      }] } })
      await until(() => !!signal)
      expect(await (await h.post("/idle", {
        sessionId: b.info.sessionId,
      })).json()).toEqual({ idle: false })
      h.message({ toolCallCancellation: { ids: ["a"] } })
      expect(signal!.aborted).toBe(true)
      await until(() => !signal || signal.aborted)
      await Bun.sleep(10)
      const state = await h.state()
      expect(state.tasks[0]).toMatchObject({ providerCancelled: true,
        outcome: "cancelled", delivery: "not_sent",
        resolution: { outcome: "cancelled", delivery: "not_sent" },
      })
      expect(runs).toBe(1)
      expect(h.wires.some(w => w.toolResponse)).toBe(false)
      expect(await (await h.post("/idle", {
        sessionId: b.info.sessionId,
      })).json()).toEqual({ idle: true })
    } finally { await h.server.stop() }
  })

for (const failure of ["goAway", "pageClose"] as const) {
  test(`pending work on ${failure} is cleaned up without execution replay`,
    async () => {
      let signal: AbortSignal | undefined
      let runs = 0
      const h = controller({ backend: async (_context, s) => {
        runs++
        signal = s
        await new Promise<void>(done => {
          s.addEventListener("abort", () => done(), { once: true })
        })
        return { status: "completed", summary: "A was already written" }
      } })
      try {
        const b = await h.ready()
        h.message({ toolCall: { functionCalls: [{
          id: "a", name: "delegate", args: { task: "Write A once" },
        }] } })
        await until(() => !!signal)
        const retired = h.socket.onmessage!
        if (failure === "goAway") h.message({ goAway: {} })
        else await h.post("/end")
        await until(() => signal!.aborted)
        await Bun.sleep(20)
        expect(runs).toBe(1)
        expect(h.connects()).toBe(1)
        if (failure === "goAway") {
          expect((await h.state()).sleeping).toBe(true)
          await h.browser()
          const starting = h.post("/start", { rate: 48000 })
          await until(() => h.connects() === 2)
          h.socket.onopen!()
          h.message({ setupComplete: {} })
          expect((await starting).status).toBe(200)
          await h.post("/ready", { events: [] })
          const seed = h.wires.find(w => w.clientContent)
          expect(JSON.stringify(seed)).toContain("A was already written")
          expect(JSON.stringify(seed)).toContain("cancelled")
          retired({ data: JSON.stringify({ toolCall: { functionCalls: [{
            id: "late", name: "delegate", args: { task: "Never execute" },
          }] } }) })
          await Bun.sleep(10)
          expect(runs).toBe(1)
          expect(h.wires.some(w => w.toolResponse)).toBe(false)
        } else {
          expect((await h.state()).ending).toBe(true)
          expect((await h.post("/recover", {
            sessionId: b.info.sessionId,
          })).status).toBe(409)
        }
      } finally { await h.server.stop() }
    })
}

for (const provider of ["openai", "gemini"] as const) {
  test(`Gemini resumes a ${provider} archive as history, not execution`,
    async () => {
      const ws = await workspace()
      const old = new History(ws, ws.dir)
      const saved: HistoryContext = {
        version: 1, conversationId: crypto.randomUUID(), incomplete: true,
        fragments: [{ sessionId: "old", sequence: 1, speaker: "user",
          text: "Write A once", ...(provider === "gemini" ? {
            provider, sessionIdSource: "local" as const,
          } : {}) }, { sessionId: "old", sequence: 2,
          speaker: "assistant", text: "Checking A" }],
        tasks: [{ sessionId: "old", delegationId: "unfinished",
          revision: 1, received: 0, outcome: "running", delivery: "pending",
          context: "Write A once" }],
      }
      old.checkpoint(saved)
      const original = await readFile(join(old.dir, "context.json"), "utf8")
      const history = new History({ ...ws, provider: "gemini",
        model: "gemini-3.8-live", resumedFrom: old.id }, ws.dir)
      const contexts: ContextEnvelope[] = []
      const h = controller({ history,
        previousSession: loadHistory(old.id, ws.dir),
        backend: async context => {
          contexts.push(context)
          return { status: "completed", summary: "A already exists" }
        },
      })
      try {
        expect(h.connects()).toBe(0)
        const b = await h.ready()
        expect(h.wires).toHaveLength(2)
        expect(h.wires[0].setup.historyConfig)
          .toEqual({ initialHistoryInClientContent: true })
        expect(h.wires[1].clientContent.turns.slice(1)).toEqual([
          { role: "user", parts: [{ text: "Write A once" }] },
          { role: "model", parts: [{ text: "Checking A" }] },
        ])
        expect(JSON.stringify(h.wires[1])).toContain("unfinished")
        expect(h.wires[1].clientContent.turnComplete).toBe(true)
        expect(contexts).toEqual([])
        b.ws.send(new Uint8Array(1920))
        await until(() => h.wires.length === 3)
        expect(h.wires[2]).toHaveProperty("realtimeInput")
        expect(contexts).toEqual([])
        h.message({ toolCall: { functionCalls: [{ id: "new",
          name: "delegate", args: { task: "Check A without writing it" },
        }] } })
        await until(() => h.wires.some(w => w.toolResponse))
        expect(contexts).toHaveLength(1)
        expect(contexts[0].previousSession).toEqual(saved)
        expect(contexts[0].conversationId).toBe(saved.conversationId)
        expect(contexts[0].sessionId).not.toBe("old")
        await h.post("/end")
        const restored = loadHistory(history.id, ws.dir)
        expect(restored.tasks).toHaveLength(2)
        expect(restored.tasks[0].outcome).toBe("running")
        expect(restored.tasks[1]).toMatchObject({ provider: "gemini",
          sessionIdSource: "local", delivery: "sent" })
        expect(await readFile(join(old.dir, "context.json"), "utf8"))
          .toBe(original)
      } finally { await h.server.stop(); await ws.cleanup() }
    })
}

for (const mode of ["throw", "goAway", "close"] as const) {
  test(`Gemini loss during result send (${mode}) checkpoints without retry`,
    async () => {
      const ws = await workspace()
      const history = new History(ws, ws.dir)
      const h = controller({ history, backend: async () => ({
        status: "completed", summary: "A was written once",
      }) })
      try {
        await h.ready()
        const send = h.socket.send
        h.socket.send = raw => {
          send(raw)
          if (!JSON.parse(raw).toolResponse) return
          if (mode === "throw") throw new Error("private send failure")
          if (mode === "goAway") h.message({ goAway: {} })
          if (mode === "close") h.socket.onclose!()
        }
        h.message({ toolCall: { functionCalls: [{ id: "write",
          name: "delegate", args: { task: "Write A once" },
        }] } })
        await until(() => h.closes() === 1)
        await Bun.sleep(30)
        expect((await h.state()).sleeping).toBe(true)
        const task = loadHistory(history.id, ws.dir).tasks[0]
        expect(task).toMatchObject({ outcome: "completed",
          delivery: mode === "throw" ? "uncertain" : "sent",
          result: { summary: "A was written once" } })
        expect(h.connects()).toBe(1)
        await h.browser()
        const pending = h.post("/start", { rate: 48000 })
        await until(() => h.connects() === 2)
        h.socket.onopen!()
        h.message({ setupComplete: {} })
        expect((await pending).status).toBe(200)
        await h.post("/ready", { events: [] })
        expect(h.wires.filter(w => w.toolResponse)).toHaveLength(1)
        const seed = JSON.stringify(h.wires.find(w => w.clientContent))
        expect(seed).toContain("A was written once")
        expect(seed).toContain(mode === "throw" ? "uncertain" : "sent")
        expect(JSON.stringify(await h.state())).not.toContain("private")
      } finally { await h.server.stop(); await ws.cleanup() }
    })
}

for (const terminal of [false, true]) {
  test(`recovery waits for backend cleanup; End wins the race (${terminal})`,
    async () => {
      let release!: () => void
      let signal: AbortSignal | undefined
      const h = controller({ backend: async (_context, abort) => {
        signal = abort
        await new Promise<void>(done => { release = done })
        return { status: "completed", summary: "Late action finding" }
      } })
      try {
        const b = await h.ready()
        h.message({ toolCall: { functionCalls: [{ id: "a",
          name: "delegate", args: { task: "Write A once" },
        }] } })
        await until(() => !!signal)
        h.message({ goAway: {} })
        await until(() => signal!.aborted)
        const stopping = terminal ? h.post("/end") : undefined
        expect((await h.state()).idling).toBe(true)
        expect((await h.browser()).ws.readyState).not.toBe(1)
        expect((await h.post("/start", { rate: 48000 })).status).toBe(409)
        release()
        await stopping
        await Bun.sleep(30)
        const state = await h.state()
        expect(state.sleeping).toBe(!terminal)
        expect(state.ending).toBe(terminal)
        expect(h.connects()).toBe(1)
        if (terminal) {
          expect((await h.post("/recover", {
            sessionId: b.info.sessionId,
          })).status).toBe(409)
        }
      } finally { release?.(); await h.server.stop() }
    })
}

test("retired media callbacks cannot send audio or flush a replacement",
  async () => {
    const outputs: ((value: PCMOutput) => void)[] = []
    let connects = 0
    const h = controller({ connect: async () => ({
      owner: { provider: "gemini", sessionId: `s${++connects}`,
        sessionIdSource: "local" },
      media: { kind: "pcm", capture() {},
        attach(sink) { outputs.push(sink) } },
      bootstrap: () => [],
      complete: async () => ({ transmission: "not_sent",
        acknowledgment: "unavailable" }),
      close: async () => ({ transport: "closed", remote: "unknown",
        usage: "unknown" }),
    }) })
    try {
      await h.browser()
      const first = await (await h.post("/start", { rate: 48000 })).json()
      await h.post("/ready", { events: [] })
      await h.post("/idle", { sessionId: first.sessionId })
      const next = await h.browser()
      await h.post("/start", { rate: 48000 })
      await h.post("/ready", { events: [] })
      outputs[0](new Uint8Array([1, 2]))
      outputs[0]("flush")
      outputs[1](new Uint8Array([3, 4]))
      await until(() => next.output.length > 0)
      expect(next.output).toHaveLength(1)
      expect(new Uint8Array(next.output[0] as ArrayBuffer))
        .toEqual(new Uint8Array([3, 4]))
    } finally { await h.server.stop() }
  })

for (const mode of ["heartbeat", "budget", "pageClose"] as const) {
  test(`${mode} aborts pending Gemini work and saves uncertainty terminally`,
    async () => {
      const ws = await workspace()
      const history = new History(ws, ws.dir)
      let signal: AbortSignal | undefined
      const h = controller({ history, watchdogMs: 5,
        maxSessionSeconds: mode === "budget" ? 1 : 600,
        heartbeatMs: mode === "heartbeat" ? 100 : 10000,
        backend: async (_context, abort) => {
          signal = abort
          await new Promise<void>(done => {
            abort.addEventListener("abort", () => done(), { once: true })
          })
          return { status: "completed", summary: "Action may have finished" }
        },
      })
      try {
        await h.ready()
        h.message({ toolCall: { functionCalls: [{ id: "a",
          name: "delegate", args: { task: "Write A once" },
        }] } })
        await until(() => !!signal)
        if (mode === "pageClose") await h.post("/close")
        await until(() => signal!.aborted)
        if (mode !== "budget") await h.server.stopped
        else {
          await h.post("/end")
          const state = await h.state()
          expect(state.sleeping).toBe(false)
          expect(state.ending).toBe(true)
          expect((await h.browser()).ws.readyState).not.toBe(1)
        }
        const task = loadHistory(history.id, ws.dir).tasks[0]
        expect(task).toMatchObject({ outcome: "cancelled",
          result: { summary: "Action may have finished" } })
        expect(h.connects()).toBe(1)
        expect(h.wires.some(w => w.toolResponse)).toBe(false)
      } finally { await h.server.stop(); await ws.cleanup() }
    })
}
