import { expect, test } from "bun:test"
import { frameSamples, PCMFramer, PCMPlayer } from "../gemini-audio"

for (const rate of [44100, 48000]) {
  test(`PCM capture at ${rate} is native-rate, clipped, LE and transferable`,
    () => {
      const frames: ArrayBuffer[] = []
      const framer = new PCMFramer(rate, frame => frames.push(frame))
      const input = new Float32Array(frameSamples(rate) * 3)
      input.set([-2, -1, -0.5, 0, 0.5, 1, 2, NaN, Infinity])
      for (let i = 0; i < input.length; i += 128) {
        framer.push(input.subarray(i, i + 128))
      }
      expect(frames).toHaveLength(3)
      expect(new Set(frames).size).toBe(3)
      expect(frames[0].byteLength).toBe(rate * 0.02 * 2)
      const view = new DataView(frames[0])
      expect(Array.from({ length: 9 }, (_, i) => view.getInt16(i * 2, true)))
        .toEqual([-32768, -32768, -16384, 0, 16384, 32767, 32767, 0, 0])
      expect([...new Uint8Array(frames[0]).slice(0, 2)]).toEqual([0, 128])
    })
}

test("capture rejects invalid rates and retains frame tails", () => {
  for (const rate of [0, -1, 7999, 96001, 44100.5, NaN]) {
    expect(() => frameSamples(rate)).toThrow()
  }
  const frames: ArrayBuffer[] = []
  const framer = new PCMFramer(44100, frame => frames.push(frame))
  framer.push(new Float32Array(881))
  expect(frames).toHaveLength(0)
  framer.push(new Float32Array([1]))
  expect(new DataView(frames[0]).getInt16(1762, true)).toBe(32767)
})

function audioContext(acquireAt: "assignment" | "start" = "assignment") {
  const sources: any[] = []
  const context = {
    state: "running", currentTime: 1, destination: {},
    createBuffer(channels: number, samples: number, rate: number) {
      expect(channels).toBe(1)
      expect(rate).toBe(24000)
      let floats = new Float32Array(samples)
      return {
        duration: samples / rate,
        get floats() { return floats },
        getChannelData: () => floats,
        acquire() {
          // WebAudio can detach previously returned channel views when a
          // source acquires the buffer. Retain the acquired sample storage.
          floats = structuredClone(floats, { transfer: [floats.buffer] })
        },
      }
    },
    createBufferSource() {
      const source = {
        startAt: 0, stopped: false, disconnected: false,
        bufferValue: undefined as any, onended: undefined,
        get buffer() { return this.bufferValue },
        set buffer(value: any) {
          this.bufferValue = value
          if (acquireAt === "assignment") value.acquire()
        },
        connect() {},
        start(time: number) {
          this.startAt = time
          if (acquireAt === "start") this.bufferValue.acquire()
        },
        stop() { this.stopped = true },
        disconnect() { this.disconnected = true },
      }
      sources.push(source)
      return source
    },
  }
  const player = new PCMPlayer(context as unknown as AudioContext)
  return { context, player, sources }
}

test("playback uses one audio clock, source cleanup and interruption reset",
  () => {
    const { context, player, sources } = audioContext()
    const pcm = new ArrayBuffer(4800)
    new DataView(pcm).setInt16(0, -32768, true)
    player.play(pcm)
    player.play(pcm)
    expect(sources[0].buffer.floats[0]).toBe(-1)
    expect(sources[0].startAt).toBeCloseTo(1.03)
    expect(sources[1].startAt).toBeCloseTo(1.13)
    sources[0].onended()
    expect(sources[0].disconnected).toBe(true)
    player.flush()
    expect(sources[1].stopped).toBe(true)
    expect(sources[1].disconnected).toBe(true)
    context.currentTime = 2
    player.play(pcm)
    expect(sources[2].startAt).toBeCloseTo(2.03)
  })

test("playback rejects invalid PCM and suspended contexts", () => {
  const { context, player } = audioContext()
  for (const bytes of [0, 1, 192002]) {
    expect(() => player.play(new ArrayBuffer(bytes))).toThrow()
  }
  expect(() => player.play(new ArrayBuffer(2), 48000)).toThrow()
  context.state = "suspended"
  expect(() => player.play(new ArrayBuffer(2))).toThrow()
})

test("five-minute bound includes queued and scheduled audio", () => {
  const { player, sources } = audioContext()
  for (let i = 0; i < 74; i++) player.play(new ArrayBuffer(192000))
  player.play(new ArrayBuffer(144000)) // 299 seconds, plus startup lead.
  expect(sources.length).toBeLessThanOrEqual(4)
  let overload: any
  try { player.play(new ArrayBuffer(48000)) } catch (e) { overload = e }
  expect(overload.message).toBe("Playback overload")
  expect(overload.queuedSeconds).toBeCloseTo(300.03)
  expect(overload.scheduledSources).toBe(sources.length)
  // A rejected chunk did not change queue state.
  expect(() => player.play(new ArrayBuffer(24000))).not.toThrow()
  player.flush()
  expect(() => player.play(new ArrayBuffer(192000))).not.toThrow()
  player.flush()
})

test("long playback drains in order with a short scheduling window", () => {
  const { context, player, sources } = audioContext()
  // Different values on either side of provider chunk/block boundaries.
  let samples = 0
  for (let frame = 0; frame < 599; frame++) {
    const pcm = new ArrayBuffer(24002)
    const view = new DataView(pcm)
    for (let i = 0; i < pcm.byteLength / 2; i++) {
      view.setInt16(i * 2, samples++ % 32768, true)
    }
    player.play(pcm)
  }
  let played = 0
  let previousEnd = 1.03
  for (let index = 0; index < sources.length; index++) {
    const source = sources[index]
    expect(source.startAt).toBeCloseTo(previousEnd)
    for (const sample of source.buffer.floats) {
      if (sample !== (played++ % 32768) / 32768) {
        throw new Error("Playback reordered or lost samples")
      }
    }
    previousEnd = source.startAt + source.buffer.floats.length / 24000
    context.currentTime = previousEnd
    source.onended()
    expect(sources.length - index - 1).toBeLessThanOrEqual(4)
    const last = sources.at(-1)!
    const scheduledEnd = last.startAt + last.buffer.floats.length / 24000
    expect(scheduledEnd - context.currentTime).toBeLessThanOrEqual(0.401)
  }
  expect(played).toBe(599 * 12001)
  expect(sources.every(source => source.disconnected)).toBe(true)
  // A drained player starts afresh rather than retaining its old cursor.
  context.currentTime += 10
  player.play(new ArrayBuffer(4800))
  expect(sources.at(-1)!.startAt).toBeCloseTo(context.currentTime + 0.03)
  player.flush()
})

test("tiny frames queue rather than exhausting the source limit", () => {
  const { context, player, sources } = audioContext()
  for (let i = 0; i < 10000; i++) player.play(new ArrayBuffer(2))
  expect(sources).toHaveLength(32)
  let samples = 0
  for (let index = 0; index < sources.length; index++) {
    const source = sources[index]
    samples += source.buffer.floats.length
    context.currentTime = source.startAt + source.buffer.floats.length / 24000
    source.onended()
    expect(sources.length - index - 1).toBeLessThanOrEqual(32)
  }
  expect(samples).toBe(10000)
})

test("flush retires scheduled and unscheduled audio, including late ends",
  () => {
    const { context, player, sources } = audioContext()
    for (let i = 0; i < 10; i++) player.play(new ArrayBuffer(192000))
    const lateEnd = sources[0].onended
    const oldCount = sources.length
    player.flush()
    expect(sources.every(source => source.stopped && source.disconnected))
      .toBe(true)
    expect(sources.every(source => source.onended === null)).toBe(true)
    context.currentTime = 2
    const pcm = new ArrayBuffer(4800)
    new DataView(pcm).setInt16(0, 32767, true)
    player.play(pcm)
    lateEnd()
    expect(sources).toHaveLength(oldCount + 1)
    const fresh = sources.at(-1)!
    expect(fresh.startAt).toBeCloseTo(2.03)
    expect(fresh.buffer.floats[0]).toBe(32767 / 32768)
    fresh.onended()
    expect(sources).toHaveLength(oldCount + 1)
  })

test("suspension during replenishment discards pending speech", () => {
  const { context, player, sources } = audioContext()
  player.play(new ArrayBuffer(192000))
  const count = sources.length
  context.state = "suspended"
  sources[0].onended()
  expect(sources.every(source => source.disconnected)).toBe(true)
  context.state = "running"
  context.currentTime = 5
  player.play(new ArrayBuffer(4800))
  expect(sources).toHaveLength(count + 1)
  expect(sources.at(-1)!.startAt).toBeCloseTo(5.03)
  player.flush()
})

test("late ends rebase scheduling without losing queued samples", () => {
  const { context, player, sources } = audioContext()
  player.play(new ArrayBuffer(192000))
  const scheduled = sources.length
  context.currentTime = 10 // Simulate delayed main-thread event delivery.
  for (let i = 0; i < scheduled; i++) sources[i].onended()
  expect(sources[scheduled].startAt).toBeCloseTo(10.03)
  let samples = sources.slice(0, scheduled).reduce((total, source) =>
    total + source.buffer.floats.length, 0)
  for (let i = scheduled; i < sources.length; i++) {
    const source = sources[i]
    samples += source.buffer.floats.length
    context.currentTime = source.startAt + source.buffer.floats.length / 24000
    source.onended()
  }
  expect(samples).toBe(96000)
})

for (const acquireAt of ["assignment", "start"] as const) {
  test(`channel detachment at ${acquireAt} cannot overlap playback`, () => {
    const { player, sources } = audioContext(acquireAt)
    for (let i = 1; i <= 3; i++) {
      const pcm = new ArrayBuffer(4800)
      const view = new DataView(pcm)
      for (let j = 0; j < 2400; j++) view.setInt16(j * 2, i * 4096, true)
      player.play(pcm)
    }
    expect(sources).toHaveLength(3)
    for (let i = 0; i < sources.length; i++) {
      expect(sources[i].startAt).toBeCloseTo(1.03 + i * 0.1)
      expect(sources[i].buffer.floats[0]).toBe((i + 1) / 8)
    }
    player.flush()
  })
}
