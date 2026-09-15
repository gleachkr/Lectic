import { expect, test } from "bun:test"
import { runInNewContext } from "node:vm"
import { browserScript, html, style } from "../web"

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

// Run the actual embedded script with deterministic browser/transport fakes.
// This tests lifecycle and drawing inputs, not real browser autoplay policy.
function browser(options: {
  token?: string; blocked?: boolean; idleTimeout?: number
} = {}) {
  const permission = deferred<any>()
  let ready = deferred<any>()
  const sleeping = deferred<any>()
  const ending = deferred<any>()
  const requests: { path: string; init: RequestInit }[] = []
  const logs: any[][] = []
  const timers = new Map<number, { fn: () => void; ms: number }>()
  const frames = new Map<number, () => void>()
  const listeners = new Map<string, Set<() => void>>()
  const lines: number[][] = []
  let id = 0
  let captures = 0
  let plays = 0
  let blocked = options.blocked ?? false
  let frequency = 0
  let now = 0
  let micLevel = 0
  let agentLevel = 0
  const peers: Peer[] = []
  const contexts: Context[] = []
  let analysisStream: unknown
  let connections = 0
  let sourceDisconnected = false
  const track = { enabled: true, stopped: false,
    stop() { this.stopped = true } }
  const clones: (typeof track)[] = []
  const media = {
    getTracks: () => [track], getAudioTracks: () => [track],
    clone() {
      const copy = { ...track }
      clones.push(copy)
      return { getTracks: () => [copy], getAudioTracks: () => [copy] }
    },
  }
  const remote = { remote: true }
  const state = { phase: "Connected", backend: "Idle", runs: 0,
    busy: false, tasks: [], captions: [], diagnostics: [],
    ending: false, usage: {} }
  const audio = { srcObject: null, paused: true,
    async play() {
      plays++
      if (blocked) throw new Error("Autoplay blocked")
      this.paused = false
    },
    pause() { this.paused = true },
  }
  const drawing = {
    setTransform() {}, clearRect() { lines.length = 0 },
    beginPath() {}, moveTo() {},
    lineTo(...point: number[]) { lines.push(point) }, stroke() {},
    strokeStyle: "", lineWidth: 0, lineCap: "",
  }
  const canvas = { width: 0, height: 0,
    getContext: () => drawing,
    getBoundingClientRect: () => ({ width: 320 }),
  }
  class Context {
    state = blocked ? "suspended" : "running"
    closed = false
    constructor() { contexts.push(this) }
    createAnalyser() {
      return {
        stream: undefined as unknown,
        getFloatTimeDomainData(data: Float32Array) {
          data.fill(this.stream === media ? micLevel
            : this.stream === remote ? agentLevel : 0)
        },
        getByteFrequencyData(data: Uint8Array) { data.fill(frequency) },
        disconnect() {},
      }
    }
    createMediaStreamSource(stream: unknown) {
      analysisStream = stream
      return {
        connect(analyser: { stream: unknown }) {
          analyser.stream = stream
          connections++
        },
        disconnect() { sourceDisconnected = true },
      }
    }
    async resume() { if (!blocked) this.state = "running" }
    async close() { this.closed = true; this.state = "closed" }
  }
  class Peer {
    closed = false
    connectionState = "connected"
    channel: any = {}
    ontrack?: (event: any) => void
    onconnectionstatechange?: () => void
    constructor() { peers.push(this) }
    addTrack(sent: typeof track) {
      expect(sent).not.toBe(track)
      expect(sent.enabled).toBe(false)
    }
    createDataChannel() { return this.channel }
    async createOffer() { return { sdp: "offer" } }
    async setLocalDescription() {}
    async setRemoteDescription() {
      this.ontrack?.({ streams: [remote] })
      this.channel.onmessage({ data: JSON.stringify({
        type: "session.started", session: { id: `s${peers.length}` },
      }) })
    }
    close() { this.closed = true; this.channel.onclose?.() }
  }
  const location = { hash: options.token === "" ? "" : "#private-token" }
  const sandbox = {
    document: { getElementById: (id: string) =>
      id === "audio" ? audio : canvas },
    location, history: { replaceState() { location.hash = "" } },
    window: {
      addEventListener(name: string, fn: () => void) {
        if (!listeners.has(name)) listeners.set(name, new Set())
        listeners.get(name)!.add(fn)
      },
      removeEventListener(name: string, fn: () => void) {
        listeners.get(name)?.delete(fn)
      },
    },
    navigator: { mediaDevices: { getUserMedia() {
      captures++
      return permission.promise
    } } },
    RTCPeerConnection: Peer, AudioContext: Context,
    devicePixelRatio: 2, AbortSignal, performance: { now: () => now },
    console: { log: (...args: any[]) => logs.push(args) },
    async fetch(path: string, init: RequestInit) {
      requests.push({ path, init })
      const value = path === "/state" ? state
        : path === "/start" ? { sdp: "answer",
          sessionId: `s${peers.length}`,
          idleTimeout: options.idleTimeout ?? 30 }
          : path === "/idle" ? await sleeping.promise
          : path === "/ready" ? await ready.promise
            : await ending.promise
      return { ok: true, json: async () => value }
    },
    setTimeout(fn: () => void, ms: number) {
      timers.set(++id, { fn, ms })
      return id
    },
    clearTimeout(id: number) { timers.delete(id) },
    requestAnimationFrame(fn: () => void) { frames.set(++id, fn); return id },
    cancelAnimationFrame(id: number) { frames.delete(id) },
  }
  runInNewContext(browserScript, sandbox)
  const flush = async () => {
    for (let i = 0; i < 40; i++) await Promise.resolve()
  }
  return {
    requests, logs, track, audio, remote, canvas, drawing, lines, state,
    permission, get ready() { return ready }, sleeping,
    ending, timers, frames, location, flush, clones,
    holdReady() { ready = deferred<any>() },
    captures: () => captures, plays: () => plays, peer: () => peers.at(-1)!,
    contexts, context: () => contexts[0],
    analysisStream: () => analysisStream,
    connections: () => connections,
    sourceDisconnected: () => sourceDisconnected,
    paths: () => requests.map(r => r.path),
    event(name: string) { listeners.get(name)?.forEach(fn => fn()) },
    unblock() { blocked = false },
    frame(value: number) {
      frequency = value
      const pending = [...frames.values()]
      frames.clear()
      pending.forEach(fn => fn())
    },
    async advance(ms: number, mic = 0, agent = 0) {
      micLevel = mic
      agentLevel = agent
      for (let elapsed = 0; elapsed < ms; elapsed += 50) {
        now += Math.min(50, ms - elapsed)
        for (const [id, timer] of [...timers]) {
          if (timer.ms !== 50) continue
          timers.delete(id)
          timer.fn()
        }
        await flush()
      }
    },
    async permit() { permission.resolve(media); await flush() },
    async poll() {
      for (const [id, timer] of timers) {
        if (timer.ms !== 500) continue
        timers.delete(id)
        timer.fn()
        break
      }
      await flush()
    },
  }
}

test("page contains only an accessible canvas and hidden audio", () => {
  expect(html).toContain('aria-label="Agent audio visualization"')
  expect(html).not.toMatch(/<(button|h1|p|section|input|details)\b/)
  expect(html).toContain('autoplay playsinline hidden')
  expect(style).toContain('background: #fff; color: #000')
  expect(browserScript).toContain('Copyright (c) 2020 Saket Roy')
})

test("URL starts immediately but permission and bootstrap gate microphone",
  async () => {
    const b = browser()
    expect(b.captures()).toBe(1)
    expect(b.location.hash).toBe("")
    expect(b.paths()).not.toContain("/start")
    await b.permit()
    expect(b.paths().filter(p => p === "/start")).toHaveLength(1)
    expect(b.paths()).toContain("/ready")
    expect(b.track.enabled).toBe(false)
    b.ready.resolve({ ok: true })
    await b.flush()
    expect(b.track.enabled).toBe(true)
    b.event("click")
    b.event("keydown")
    await b.flush()
    expect(b.captures()).toBe(1)
    expect(b.paths().filter(p => p === "/start")).toHaveLength(1)
    expect(JSON.stringify(b.logs)).not.toContain("private-token")
    b.event("pagehide")
  })

test("agent stream alone drives black radial bars and has one playback path",
  async () => {
    const b = browser()
    await b.permit()
    expect(b.analysisStream()).toBe(b.remote)
    expect(b.connections()).toBe(1)
    expect(b.audio.paused).toBe(false)
    expect(b.canvas.width).toBe(640)
    expect(b.drawing.strokeStyle).toBe("#000")
    b.frame(0)
    expect(b.lines).toHaveLength(150)
    expect(b.lines[0][0]).toBeCloseTo(175)
    b.frame(255)
    expect(b.lines[0][0]).toBeCloseTo(20)
    b.event("pagehide")
    expect(b.sourceDisconnected()).toBe(true)
    expect(b.context().closed).toBe(true)
    expect(b.frames.size).toBe(0)
    expect(b.lines[0][0]).toBeCloseTo(175)
  })

test("autoplay blockers log and any click retries without another session",
  async () => {
    const b = browser({ blocked: true })
    await b.permit()
    expect(JSON.stringify(b.logs)).toContain("autoplay blocked")
    b.frame(255)
    expect(b.lines[0][0]).toBeCloseTo(175)
    b.unblock()
    b.event("click")
    await b.flush()
    expect(b.context().state).toBe("running")
    expect(b.audio.paused).toBe(false)
    expect(b.plays()).toBe(2)
    expect(b.paths().filter(p => p === "/start")).toHaveLength(1)
    b.event("pagehide")
  })

test("pagehide releases media and sends authenticated keepalive immediately",
  async () => {
    const b = browser()
    await b.permit()
    b.event("pagehide")
    expect(b.track.stopped).toBe(true)
    expect(b.peer().closed).toBe(true)
    expect(b.audio.srcObject).toBeNull()
    expect(b.audio.paused).toBe(true)
    expect(b.requests.at(-1)).toMatchObject({ path: "/end", init: {
      method: "POST", keepalive: true,
      headers: { Authorization: "Bearer private-token" },
    } })
    b.ready.resolve({ ok: true })
    await b.flush()
    expect(b.track.enabled).toBe(false)
    expect(b.timers.size).toBe(0)
    const count = b.requests.length
    await b.poll()
    b.event("click")
    expect(b.requests).toHaveLength(count)
  })

test("closing during microphone permission cannot create a late session",
  async () => {
    const b = browser()
    b.event("pagehide")
    await b.permit()
    expect(b.track.stopped).toBe(true)
    expect(b.paths()).not.toContain("/start")
    expect(b.timers.size).toBe(0)
  })

test("microphone denial logs, ends, and never creates a paid session",
  async () => {
    const b = browser()
    b.permission.reject(new Error("Permission denied"))
    b.ending.resolve({ confirmed: true })
    await b.flush()
    expect(b.paths()).not.toContain("/start")
    expect(b.paths()).toContain("/end")
    expect(b.frames.size).toBe(0)
    expect(b.timers.size).toBe(0)
  })

test("missing token never captures, starts, polls, or sends an end request",
  () => {
    const b = browser({ token: "" })
    b.event("pagehide")
    expect(b.captures()).toBe(0)
    expect(b.requests).toEqual([])
    expect(b.frames.size).toBe(0)
    expect(JSON.stringify(b.logs)).toContain("private URL")
  })

test("server shutdown silences immediately and retains peer until handshake",
  async () => {
    const b = browser()
    await b.permit()
    b.ready.resolve({ ok: true })
    await b.flush()
    b.state.ending = true
    await b.poll()
    expect(b.track.stopped).toBe(true)
    expect(b.audio.paused).toBe(true)
    expect(b.peer().closed).toBe(false)
    expect(b.context().closed).toBe(true)
    b.ending.resolve({ confirmed: true })
    await b.flush()
    expect(b.peer().closed).toBe(true)
    expect(JSON.stringify(b.logs)).toContain("final usage")
    expect(b.paths().filter(p => p === "/end")).toHaveLength(1)
    expect(b.timers.size).toBe(0)
  })

test("idle closes before wake reconnects; microphone stays local throughout",
  async () => {
    const b = browser()
    await b.permit()
    b.ready.resolve({ ok: true })
    await b.flush()
    const oldPeer = b.peer()
    const sent = b.clones[0]
    expect(sent.enabled).toBe(true)
    await b.advance(15_000)
    b.frame(0)
    expect(b.drawing.strokeStyle).toBe("#000")
    await b.advance(7500)
    b.frame(0)
    expect(b.drawing.strokeStyle).toBe("rgb(85, 85, 85)")
    await b.advance(7500)
    b.frame(0)
    expect(b.drawing.strokeStyle).toBe("rgb(170, 170, 170)")
    expect(b.paths().filter(p => p === "/idle")).toHaveLength(1)
    expect(b.requests.find(r => r.path === "/idle")?.init.body)
      .toBe(JSON.stringify({ sessionId: "s1" }))
    expect(sent.enabled).toBe(false)
    expect(b.track.enabled).toBe(true)
    expect(b.track.stopped).toBe(false)
    expect(oldPeer.closed).toBe(false)
    expect(b.audio.paused).toBe(true)
    b.event("click")
    await b.flush()
    expect(b.audio.paused).toBe(true)
    // Noise while close is pending must not overlap two paid sessions.
    await b.advance(50, .1)
    expect(b.paths().filter(p => p === "/start")).toHaveLength(1)
    b.holdReady()
    b.sleeping.resolve({ idle: true })
    await b.flush()
    expect(oldPeer.closed).toBe(true)
    expect(sent.stopped).toBe(true)
    expect(b.paths().filter(p => p === "/start")).toHaveLength(2)
    expect(b.captures()).toBe(1)
    expect(b.clones[1].enabled).toBe(false)
    oldPeer.channel.onmessage({ data: JSON.stringify({
      type: "session.started", session: { id: "s1" },
    }) })
    oldPeer.channel.onclose()
    oldPeer.onconnectionstatechange?.()
    expect(b.paths()).not.toContain("/end")
    b.ready.resolve({ ok: true })
    await b.flush()
    expect(b.clones[1].enabled).toBe(true)
    const bootstraps = b.requests.filter(r => r.path === "/ready")
    expect(bootstraps.at(-1)?.init.body).not.toContain("s1")
    expect(b.paths().filter(p => p === "/ready")).toHaveLength(2)
    await b.advance(50)
    b.frame(0)
    expect(b.drawing.strokeStyle).toBe("#000")
    b.event("pagehide")
    expect(b.clones.every(t => t.stopped)).toBe(true)
    expect(b.contexts.every(c => c.closed)).toBe(true)
    expect(b.timers.size).toBe(0)
  })

test("configured timeout allows repeated sleep/wake without extra captures",
  async () => {
    const b = browser({ idleTimeout: 2 })
    await b.permit()
    b.ready.resolve({ ok: true })
    b.sleeping.resolve({ idle: true })
    await b.flush()
    for (let cycle = 0; cycle < 3; cycle++) {
      await b.advance(3000)
      expect(b.peer().closed).toBe(true)
      expect(b.paths().filter(p => p === "/start"))
        .toHaveLength(cycle + 1)
      b.event("click")
      await b.advance(5000)
      expect(b.paths().filter(p => p === "/start"))
        .toHaveLength(cycle + 1)
      await b.advance(50, .2)
      expect(b.paths().filter(p => p === "/start"))
        .toHaveLength(cycle + 2)
      expect(b.clones.at(-1)?.enabled).toBe(true)
    }
    expect(b.captures()).toBe(1)
    b.event("pagehide")
  })

test("agent audio and pending backend work prevent browser idle requests",
  async () => {
    const b = browser({ idleTimeout: 1 })
    await b.permit()
    b.ready.resolve({ ok: true })
    await b.flush()
    await b.advance(2000, 0, .1)
    expect(b.paths()).not.toContain("/idle")
    b.state.busy = true
    await b.poll()
    await b.advance(2000)
    expect(b.paths()).not.toContain("/idle")
    b.state.busy = false
    await b.poll()
    await b.advance(1000)
    expect(b.paths()).toContain("/idle")
    b.event("pagehide")
    b.sleeping.resolve({ idle: true })
    await b.flush()
    expect(b.paths().filter(p => p === "/start")).toHaveLength(1)
    expect(b.timers.size).toBe(0)
  })

test("idle rejection restores media without reconnecting", async () => {
  const b = browser({ idleTimeout: 1 })
  await b.permit()
  b.ready.resolve({ ok: true })
  b.sleeping.resolve({ idle: false })
  await b.flush()
  await b.advance(1000)
  expect(b.paths()).toContain("/idle")
  expect(b.clones[0].enabled).toBe(true)
  expect(b.peer().closed).toBe(false)
  expect(b.audio.paused).toBe(false)
  expect(b.paths().filter(p => p === "/start")).toHaveLength(1)
  b.event("pagehide")
})

test("uncertain idle close stops without reconnecting", async () => {
  const b = browser({ idleTimeout: 1 })
  await b.permit()
  b.ready.resolve({ ok: true })
  b.ending.resolve({ confirmed: false })
  await b.flush()
  await b.advance(1000)
  b.sleeping.reject(new Error("Controller unavailable"))
  await b.flush()
  await b.advance(1000, .5)
  expect(b.paths().filter(p => p === "/start")).toHaveLength(1)
  expect(b.track.stopped).toBe(true)
  expect(b.timers.size).toBe(0)
})

test("suspended microphone analysis does not cause sleep or false wakes",
  async () => {
    const b = browser({ idleTimeout: 1 })
    await b.permit()
    b.ready.resolve({ ok: true })
    b.sleeping.resolve({ idle: true })
    await b.flush()
    const monitor = b.contexts.at(-1)!
    monitor.state = "suspended"
    await b.advance(3000)
    expect(b.paths()).not.toContain("/idle")
    b.event("click")
    await b.advance(1000)
    expect(b.paths()).toContain("/idle")
    expect(b.peer().closed).toBe(true)
    monitor.state = "suspended"
    await b.advance(3000, .2)
    b.event("click")
    await b.advance(1000, .2)
    expect(b.paths().filter(p => p === "/start")).toHaveLength(1)
    await b.advance(50, .01)
    expect(b.paths().filter(p => p === "/start")).toHaveLength(2)
    b.event("pagehide")
  })

test("closing during wake bootstrap prevents late microphone enable",
  async () => {
    const b = browser({ idleTimeout: 1 })
    await b.permit()
    b.ready.resolve({ ok: true })
    b.sleeping.resolve({ idle: true })
    await b.flush()
    await b.advance(1000)
    b.holdReady()
    await b.advance(50, .2)
    await b.advance(50, .2)
    b.frame(0)
    expect(b.drawing.strokeStyle).toBe("rgb(170, 170, 170)")
    expect(b.clones[1].enabled).toBe(false)
    b.event("pagehide")
    b.ready.resolve({ ok: true })
    await b.flush()
    expect(b.clones[1].enabled).toBe(false)
    expect(b.clones.every(t => t.stopped)).toBe(true)
    expect(b.track.stopped).toBe(true)
    expect(b.contexts.every(c => c.closed)).toBe(true)
    expect(b.timers.size).toBe(0)
    expect(b.frames.size).toBe(0)
  })
