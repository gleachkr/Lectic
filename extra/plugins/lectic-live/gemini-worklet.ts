import { PCMFramer, frameSamples } from "./gemini-audio"

declare const sampleRate: number
declare class AudioWorkletProcessor {
  port: MessagePort
}
declare function registerProcessor(
  name: string, processor: typeof AudioWorkletProcessor,
): void

function registerCapture(Framer: typeof PCMFramer) {
  class Capture extends AudioWorkletProcessor {
    private enabled = false
    private epoch = 0
    private outstanding = 0
    private framer = new Framer(sampleRate, pcm => {
      // Bound the transferable-message queue even if the main thread stalls.
      if (++this.outstanding > 25) {
        this.enabled = false
        this.port.postMessage({ type: "overload" })
        return
      }
      this.port.postMessage({ pcm, epoch: this.epoch }, [pcm])
    })

    constructor() {
      super()
      this.port.onmessage = event => {
        const command = event.data
        if (command && (command.type === "start" || command.type === "stop")
          && Number.isSafeInteger(command.epoch)) {
          this.enabled = command.type === "start"
          this.epoch = command.epoch
          this.framer.reset()
        }
        if (event.data === "ack" && this.outstanding > 0) this.outstanding--
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
}

// No runtime build, relative URL imports or source-tree reads are needed.
export const workletScript = `
const frameSamples = ${frameSamples.toString()};
(${registerCapture.toString()})(${PCMFramer.toString()});
`
