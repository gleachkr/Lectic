import { PCMFramer } from "../gemini-audio"

declare const sampleRate: number
declare class AudioWorkletProcessor {
  port: MessagePort
}
declare function registerProcessor(
  name: string, processor: typeof AudioWorkletProcessor,
): void

class Capture extends AudioWorkletProcessor {
  private enabled = false
  private outstanding = 0
  private framer = new PCMFramer(sampleRate, pcm => {
    // Bound the transferable-message queue even if the main thread stalls.
    if (++this.outstanding > 25) {
      this.enabled = false
      this.port.postMessage({ type: "overload" })
      return
    }
    this.port.postMessage(pcm, [pcm])
  })

  constructor() {
    super()
    this.port.onmessage = event => {
      if (event.data === "start") this.enabled = true
      if (event.data === "stop") this.enabled = false
      if (event.data === "ack") this.outstanding--
    }
  }

  process(inputs: Float32Array[][]) {
    const mono = inputs[0]?.[0]
    if (this.enabled && mono) this.framer.push(mono)
    // Output is silence; the destination connection keeps capture running.
    return true
  }
}
registerProcessor("lectic-pcm", Capture)
