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
function browser(options: { token?: string; blocked?: boolean } = {}) {
  const permission = deferred<any>()
  const ready = deferred<any>()
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
  const peers: Peer[] = []
  const contexts: Context[] = []
  let analysisStream: unknown
  let connections = 0
  let sourceDisconnected = false
  const track = { enabled: true, stopped: false,
    stop() { this.stopped = true } }
  const media = { getTracks: () => [track], getAudioTracks: () => [track] }
  const remote = { remote: true }
  const state = { phase: "Connected", backend: "Idle", runs: 0,
    tasks: [], captions: [], diagnostics: [], ending: false, usage: {} }
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
        getByteFrequencyData(data: Uint8Array) { data.fill(frequency) },
        disconnect() {},
      }
    }
    createMediaStreamSource(stream: unknown) {
      analysisStream = stream
      return {
        connect() { connections++ },
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
    addTrack() { expect(track.enabled).toBe(false) }
    createDataChannel() { return this.channel }
    async createOffer() { return { sdp: "offer" } }
    async setLocalDescription() {}
    async setRemoteDescription() {
      this.ontrack?.({ streams: [remote] })
      this.channel.onmessage({ data: JSON.stringify({
        type: "session.started", session: { id: "s1" },
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
    devicePixelRatio: 2, AbortSignal,
    console: { log: (...args: any[]) => logs.push(args) },
    async fetch(path: string, init: RequestInit) {
      requests.push({ path, init })
      const value = path === "/state" ? state
        : path === "/start" ? { sdp: "answer" }
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
    permission, ready, ending, timers, frames, location, flush,
    captures: () => captures, plays: () => plays, peer: () => peers[0],
    context: () => contexts[0], analysisStream: () => analysisStream,
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
