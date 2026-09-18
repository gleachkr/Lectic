import { expect, test } from "bun:test"
import { runInNewContext } from "node:vm"
import { createGeminiMedia } from "../browser-media"
import { workletScript } from "../gemini-worklet"

const flush = async () => {
  for (let n = 0; n < 30; n++) await Promise.resolve()
}
function browser(blocked = false) {
  const contexts: Context[] = []
  const captures: Capture[] = []
  const sockets: Socket[] = []
  const plays: unknown[] = []
  const requests: { path: string; body: any }[] = []
  const streams: unknown[] = []
  const logs: unknown[] = []
  const timers = new Map<number, () => void>()
  let id = 0
  let lost = 0
  let flushes = 0
  let playbackError: Error | undefined
  let resolveReady!: (value: object) => void
  const ready = new Promise(resolve => { resolveReady = resolve })
  const mic = {}
  const bridge = { stream: { getTracks: () => [] }, disconnect() {} }
  const connections: unknown[] = []
  let sourceClosed = false
  class Context {
    state = blocked ? "suspended" : "running"
    sampleRate = 44100
    destination = { silent: true }
    onstatechange?: () => void
    audioWorklet = { addModule: async (url: string) => {
      expect(url).toBe("/worklet.js")
    } }
    constructor() { contexts.push(this) }
    async resume() {
      if (!blocked) { this.state = "running"; this.onstatechange?.() }
    }
    async close() { this.state = "closed" }
    createMediaStreamDestination() { return bridge }
    createMediaStreamSource(stream: unknown) {
      expect(stream).toBe(mic)
      return {
        connect: (to: unknown) => connections.push(to),
        disconnect() { sourceClosed = true },
      }
    }
  }
  class Capture {
    messages: any[] = []
    disconnected = false
    portClosed = false
    port = {
      onmessage: undefined as
        ((event: { data: unknown }) => void) | undefined,
      postMessage: (value: unknown) => this.messages.push(value),
      close: () => { this.portClosed = true },
    }
    constructor(_context: unknown, name: string, options: unknown) {
      expect(name).toBe("lectic-pcm")
      expect(options).toEqual({ channelCount: 1,
        channelCountMode: "explicit", outputChannelCount: [1] })
      captures.push(this)
    }
    connect(to: unknown) { connections.push(to) }
    disconnect() { this.disconnected = true }
  }
  class Player {
    constructor(_context: unknown, destination: unknown) {
      expect(destination).toBe(bridge)
    }
    play(value: unknown) {
      if (playbackError) throw playbackError
      plays.push(value)
    }
    flush() { flushes++ }
  }
  class Socket {
    static OPEN = 1
    readyState = 0
    bufferedAmount = 0
    sent: unknown[] = []
    onopen?: () => void
    onmessage?: (event: { data: unknown }) => void
    onclose?: () => void
    onerror?: () => void
    constructor(url: string, protocols: string[]) {
      expect(url).toBe("ws://127.0.0.1:9000/socket")
      expect(protocols).toEqual(["lectic-live-pcm", "auth.private"])
      sockets.push(this)
    }
    send(value: unknown) { this.sent.push(value) }
    close() { this.readyState = 3; this.onclose?.() }
    open() { this.readyState = 1; this.onopen?.() }
  }
  const transport = runInNewContext(
    `(${createGeminiMedia.toString()})(options, Player)`, {
      options: { token: "private",
        async command(path: string, body: object) {
          requests.push({ path, body })
          if (path === "/ready") return ready
          return { sessionId: "s", idleTimeout: 30 }
        },
        stream: (stream: unknown) => streams.push(stream),
        lost: () => { lost++; transport.close() },
      }, Player, Error, AudioContext: Context, AudioWorkletNode: Capture,
      WebSocket: Socket, location: { host: "127.0.0.1:9000" }, ArrayBuffer,
      console: { log: (...values: unknown[]) => logs.push(values) },
      setTimeout: (fn: () => void) => { timers.set(++id, fn); return id },
      clearTimeout: (id: number) => timers.delete(id),
    },
  ) as ReturnType<typeof createGeminiMedia>
  return { transport, contexts, captures, sockets, plays, requests, streams,
    timers, logs, connections, bridge, mic, resolveReady,
    lost: () => lost, flushes: () => flushes,
    sourceClosed: () => sourceClosed,
    unblock() { blocked = false },
    overloadPlayback() {
      playbackError = Object.assign(new Error("Playback overload"), {
        queuedSeconds: 300.2, scheduledSources: 3,
      })
    },
    async start() {
      const pending = transport.start(mic as MediaStream)
      void pending.catch(() => {})
      await flush()
      return { pending }
    },
  }
}

test("Gemini audio gates capture on readiness and has one audible bridge",
  async () => {
    const b = browser()
    const { pending } = await b.start()
    const socket = b.sockets[0]
    const capture = b.captures[0]
    expect(b.requests).toEqual([])
    socket.open()
    await flush()
    expect(b.requests).toEqual([
      { path: "/start", body: { rate: 44100 } },
      { path: "/ready", body: { events: [] } },
    ])
    capture.port.onmessage!({ data: {
      pcm: new ArrayBuffer(1764), epoch: 1,
    } })
    expect(socket.sent).toEqual([])
    b.resolveReady({})
    await pending
    expect(capture.messages.some(m => m?.type === "start")).toBe(false)
    b.transport.resume()
    expect(capture.messages.at(-1)).toEqual({ type: "start", epoch: 1 })
    capture.port.onmessage!({ data: {
      pcm: new ArrayBuffer(1764), epoch: 1,
    } })
    expect(socket.sent).toHaveLength(1)
    socket.onmessage!({ data: new ArrayBuffer(4) })
    expect(b.plays).toHaveLength(1)
    expect(b.streams).toEqual([b.bridge.stream])
    expect(b.connections).toEqual([capture, b.contexts[0].destination])
    socket.onmessage!({ data: '{"type":"flush"}' })
    expect(b.flushes()).toBe(1)
    b.transport.pause()
    capture.port.onmessage!({ data: {
      pcm: new ArrayBuffer(1764), epoch: 1,
    } })
    socket.onmessage!({ data: new ArrayBuffer(4) })
    expect(socket.sent).toHaveLength(1)
    expect(b.plays).toHaveLength(1)
    b.transport.close()
    expect(capture.disconnected).toBe(true)
    expect(capture.portClosed).toBe(true)
    expect(b.sourceClosed()).toBe(true)
    expect(b.contexts[0].state).toBe("closed")
    expect(b.timers.size).toBe(0)
    expect(b.lost()).toBe(0)
  })

test("autoplay precedes paid startup; suspension never replays audio",
  async () => {
    const b = browser(true)
    const { pending } = await b.start()
    expect(b.requests).toEqual([])
    expect(b.sockets).toEqual([])
    expect(JSON.stringify(b.logs)).toContain("autoplay blocked")
    b.unblock()
    b.transport.unlock()
    await flush()
    b.sockets[0].open()
    b.resolveReady({})
    await pending
    b.transport.resume()
    const context = b.contexts[0]
    const socket = b.sockets[0]
    context.state = "suspended"
    context.onstatechange!()
    expect(b.captures[0].messages.at(-1))
      .toEqual({ type: "stop", epoch: 2 })
    socket.onmessage!({ data: new ArrayBuffer(4) })
    expect(b.plays).toEqual([])
    b.transport.unlock()
    await flush()
    expect(b.captures[0].messages.at(-1))
      .toEqual({ type: "start", epoch: 3 })
    b.captures[0].port.onmessage!({ data: {
      pcm: new ArrayBuffer(1764), epoch: 1,
    } })
    expect(socket.sent).toEqual([])
    expect(b.contexts).toHaveLength(1)
    expect(b.sockets).toHaveLength(1)
    expect(b.requests.filter(r => r.path === "/start")).toHaveLength(1)
    socket.onmessage!({ data: new ArrayBuffer(4) })
    expect(b.plays).toHaveLength(1)
    b.transport.close()
  })

for (const mode of ["blocked", "socket", "ready"]) {
  test(`closing during ${mode} startup retires pending operations`,
    async () => {
      const b = browser(mode === "blocked")
      const { pending } = await b.start()
      if (mode === "ready") { b.sockets[0].open(); await flush() }
      b.transport.close()
      b.resolveReady({})
      await expect(pending).rejects.toThrow(/startup/i)
      b.unblock()
      b.transport.unlock()
      await flush()
      expect(b.contexts[0].state).toBe("closed")
      expect(b.timers.size).toBe(0)
      if (mode === "blocked") expect(b.requests).toHaveLength(0)
      else expect(b.captures[0].messages.some(m => m?.type === "start"))
        .toBe(false)
    })
}

for (const mode of ["backpressure", "workletOverload", "invalidControl",
  "socketError", "socketClose", "playbackOverload"]) {
  test(`Gemini browser ${mode} terminates rather than accumulating audio`,
    async () => {
      const b = browser()
      const { pending } = await b.start()
      const socket = b.sockets[0]
      socket.open()
      b.resolveReady({})
      await pending
      b.transport.resume()
      if (mode === "backpressure") {
        socket.bufferedAmount = 191999
        b.captures[0].port.onmessage!({ data: {
          pcm: new ArrayBuffer(1764), epoch: 1,
        } })
      }
      if (mode === "workletOverload") {
        b.captures[0].port.onmessage!({ data: { type: "overload" } })
      }
      if (mode === "invalidControl") socket.onmessage!({ data: "{}" })
      if (mode === "playbackOverload") {
        b.overloadPlayback()
        socket.onmessage!({ data: new ArrayBuffer(4) })
        expect(JSON.stringify(b.logs)).toContain("playback_overload")
        expect(JSON.stringify(b.logs)).toContain('"queuedSeconds":300.2')
      }
      if (mode === "socketError") socket.onerror!()
      if (mode === "socketClose") socket.onclose!()
      expect(b.lost()).toBe(1)
      expect(JSON.stringify(b.logs)).toContain("browser audio failure")
      expect(JSON.stringify(b.logs)).not.toContain("auth.private")
      expect(socket.sent).toEqual([])
      expect(b.contexts[0].state).toBe("closed")
    })
}

for (const rate of [44100, 48000]) {
  test(`embedded worklet at ${rate} bounds transfers and resets paused tails`,
    () => {
      const messages: { data: any; transfer?: ArrayBuffer[] }[] = []
      let Capture: any
      runInNewContext(workletScript, {
        sampleRate: rate, ArrayBuffer, DataView, Float32Array,
        AudioWorkletProcessor: class {
          port = { onmessage: undefined,
            postMessage(data: unknown, transfer?: ArrayBuffer[]) {
              messages.push({ data, transfer })
            } }
        },
        registerProcessor(name: string, constructor: unknown) {
          expect(name).toBe("lectic-pcm")
          Capture = constructor
        },
      })
      const capture = new Capture()
      const send = (type: string) => capture.port.onmessage({
        data: type === "ack" ? "ack" : { type, epoch: 1 },
      })
      const count = rate * .02
      capture.process([[new Float32Array(count)]])
      expect(messages).toEqual([])
      send("start")
      capture.process([[new Float32Array(count - 1).fill(1)]])
      send("stop")
      send("start")
      capture.process([[new Float32Array(count).fill(-1)]])
      expect(messages).toHaveLength(1)
      expect(messages[0].transfer).toEqual([messages[0].data.pcm])
      expect(new DataView(messages[0].data.pcm).getInt16(0, true))
        .toBe(-32768)
      send("ack")
      // Worklet sees the explicitly downmixed first channel, never stereo.
      for (let i = 0; i < 26; i++) {
        capture.process([[new Float32Array(count),
          new Float32Array(count).fill(1)]])
      }
      expect(messages.at(-1)?.data).toEqual({ type: "overload" })
      expect(messages.filter(m => m.data.pcm instanceof ArrayBuffer))
        .toHaveLength(26)
      capture.process([[new Float32Array(count)]])
      expect(messages).toHaveLength(27)
    })
}
