// PCM capture and playback mechanics for Gemini Live.
export function frameSamples(rate: number): number {
  if (!Number.isInteger(rate) || rate < 8000 || rate > 96000) {
    throw new Error("Invalid capture rate")
  }
  return Math.round(rate * 0.02)
}

export class PCMFramer {
  private bytes: ArrayBuffer
  private view: DataView
  private offset = 0
  readonly samples: number

  constructor(rate: number, private emit: (pcm: ArrayBuffer) => void) {
    this.samples = frameSamples(rate)
    this.bytes = new ArrayBuffer(this.samples * 2)
    this.view = new DataView(this.bytes)
  }

  reset() { this.offset = 0 }

  push(input: Float32Array) {
    for (const value of input) {
      const sample = Number.isFinite(value)
        ? Math.max(-1, Math.min(1, value)) : 0
      this.view.setInt16(this.offset * 2,
        Math.round(sample * (sample < 0 ? 32768 : 32767)), true)
      if (++this.offset === this.samples) {
        this.emit(this.bytes)
        this.bytes = new ArrayBuffer(this.samples * 2)
        this.view = new DataView(this.bytes)
        this.offset = 0
      }
    }
  }
}

export class PCMPlayer {
  private next = 0
  private sources = new Set<AudioBufferSourceNode>()
  // Pack incoming chunks into 100 ms blocks. Both sample storage and object
  // count stay bounded, even if the provider sends many tiny frames.
  private queue: { pcm: Uint8Array; used: number }[] = []
  private queuedBytes = 0

  constructor(
    private context: AudioContext,
    private destination: AudioNode = context.destination,
  ) {}

  play(pcm: ArrayBuffer, rate = 24000) {
    if (rate !== 24000 || !pcm.byteLength || pcm.byteLength % 2
      || pcm.byteLength > 192000 || this.context.state !== "running") {
      throw new Error("Invalid playback frame or suspended audio")
    }
    const now = this.context.currentTime
    const start = Math.max(now + 0.03, this.next)
    const queuedSeconds = start - now
      + (this.queuedBytes + pcm.byteLength) / 48000
    if (queuedSeconds > 300) {
      throw Object.assign(new Error("Playback overload"), {
        queuedSeconds,
        scheduledSources: this.sources.size,
      })
    }
    const input = new Uint8Array(pcm)
    for (let offset = 0; offset < input.length;) {
      let block = this.queue.at(-1)
      if (!block || block.used === block.pcm.length) {
        block = { pcm: new Uint8Array(4800), used: 0 }
        this.queue.push(block)
      }
      const count = Math.min(input.length - offset,
        block.pcm.length - block.used)
      block.pcm.set(input.subarray(offset, offset + count), block.used)
      block.used += count
      offset += count
    }
    this.queuedBytes += pcm.byteLength
    this.schedule()
  }

  private schedule() {
    if (this.context.state !== "running") {
      this.flush()
      return
    }
    const now = this.context.currentTime
    // At most 400 ms is scheduled (300 ms lookahead plus one 100 ms block).
    // End events replenish the window; no timer survives drain or flush.
    while (this.queue.length && this.sources.size < 32) {
      const start = Math.max(now + 0.03, this.next)
      if (start >= now + 0.3) break
      const block = this.queue.shift()!
      this.queuedBytes -= block.used
      const buffer = this.context.createBuffer(1, block.used / 2, 24000)
      const output = buffer.getChannelData(0)
      const view = new DataView(block.pcm.buffer)
      for (let i = 0; i < output.length; i++) {
        output[i] = view.getInt16(i * 2, true) / 32768
      }
      // Acquiring this buffer can detach `output` (e.g. in Firefox).
      // Use AudioBuffer metadata, never a channel view's length, for timing.
      const duration = buffer.duration
      const source = this.context.createBufferSource()
      source.buffer = buffer
      source.connect(this.destination)
      source.onended = () => {
        source.disconnect()
        if (this.sources.delete(source)) this.schedule()
      }
      this.sources.add(source)
      source.start(start)
      this.next = start + duration
    }
  }

  flush() {
    for (const source of this.sources) {
      source.onended = null
      try { source.stop() } catch { /* Already ended. */ }
      source.disconnect()
    }
    this.sources.clear()
    this.queue = []
    this.queuedBytes = 0
    this.next = 0
  }
}
