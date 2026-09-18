import { MAX_RESULT_BYTES } from "../result"
import { frameSamples } from "../gemini-audio"
import { decode, historySeed, setup, toolResult, type Call } from "./wire"

export type SpikeOptions = {
  real?: (task: string, signal: AbortSignal) => Promise<string>
  history?: boolean
  fakeDelayMs?: number
  sendProvider: (wire: string) => void
  sendBrowser: (data: string | Uint8Array) => void
  close: () => void
}
type Job = Call & {
  number: number
  abort: AbortController
  state: "queued" | "running" | "sent" | "cancelled"
  approved: boolean
}

// This is a finite spike scheduler, not the production task coordinator.
export class SpikeSession {
  ready = false
  ended = false
  private opened = false
  private rate = 0
  private jobs = new Map<string, Job>()
  private cancelled = new Set<string>()
  private active?: Job
  private realUsed = false
  private sequence = 0
  private receipt = 0
  private running?: Promise<void>
  private began = Date.now()
  private audioIn = 0
  private audioOut = 0
  private timer?: ReturnType<typeof setTimeout>

  constructor(private options: SpikeOptions) {}

  private browser(value: unknown) {
    this.options.sendBrowser(JSON.stringify(value))
  }

  trace(code: string, detail: Record<string, unknown> = {}) {
    this.browser({ type: "trace", sequence: ++this.sequence,
      ms: Date.now() - this.began, receipt: this.receipt, code, ...detail })
  }

  open(rate: number) {
    if (this.ended || this.opened) throw new Error("Invalid startup")
    frameSamples(rate)
    this.rate = rate
    this.opened = true
    this.timer = setTimeout(() => this.stop("setup_timeout"), 15000)
    this.send(setup(!!this.options.real, !!this.options.history))
    this.trace("setup_sent", { rate, real: !!this.options.real,
      history: !!this.options.history })
  }

  private send(value: unknown) {
    if (this.ended) throw new Error("Session ended")
    this.options.sendProvider(JSON.stringify(value))
  }

  receive(raw: string) {
    if (this.ended) return
    try {
      this.receipt++
      const observations = decode(raw)
      for (const event of observations) {
        if (this.ended) break
        if (event.type === "setup") {
          if (this.ready || !this.opened) throw new Error("Unexpected setup")
          clearTimeout(this.timer)
          this.trace("setup_complete")
          if (this.options.history) {
            this.send(historySeed)
            this.trace("history_sent")
          }
          this.ready = true
          this.browser({ type: "ready", rate: this.rate })
        } else if (event.type === "goAway") {
          this.stop("go_away")
        } else if (event.type === "usage") {
          this.trace("usage_latest_not_final", { counters: event.counters })
        } else {
          if (!this.ready) throw new Error("Provider event before setup")
          switch (event.type) {
            case "audio":
              this.options.sendBrowser(event.pcm)
              if (++this.audioOut % 50 === 1) {
                this.trace("audio_output", { frames: this.audioOut,
                  rate: 24000 })
              }
              break
            case "input": case "output":
              this.trace(event.type + "_transcript", {
                bytes: Buffer.byteLength(event.text),
              })
              this.browser({ type: "transcript", speaker: event.type,
                text: event.text, receipt: this.receipt })
              break
            case "call": this.enqueue(event.call); break
            case "cancel": this.cancel(event.id); break
            case "interrupted":
              this.browser({ type: "flush" })
              this.trace("interrupted")
              break
            default: this.trace(event.type)
          }
        }
      }
    } catch { this.stop("provider_protocol_or_transport_failure") }
  }

  capture(pcm: Uint8Array) {
    if (!this.ready || this.ended
      || pcm.byteLength !== frameSamples(this.rate) * 2) {
      throw new Error("Invalid capture frame or not ready")
    }
    this.send({ realtimeInput: { audio: {
      mimeType: `audio/pcm;rate=${this.rate}`,
      data: Buffer.from(pcm).toString("base64"),
    } } })
    if (++this.audioIn % 250 === 1) {
      this.trace("audio_input", { frames: this.audioIn, rate: this.rate })
    }
  }

  private enqueue(call: Call) {
    if (this.jobs.has(call.id) || this.cancelled.has(call.id)) {
      this.trace("duplicate_or_cancelled_call")
      return
    }
    if (this.jobs.size >= 128) throw new Error("Call retention limit")
    const pending = [...this.jobs.values()].filter(job =>
      job.state === "queued" || job.state === "running")
    if (pending.length >= 4) throw new Error("Task queue limit")
    const job: Job = { ...call, number: this.jobs.size + 1,
      abort: new AbortController(), state: "queued", approved: false }
    this.jobs.set(call.id, job)
    this.trace("call_received", { call: job.number })
    if (this.options.real && !this.realUsed) {
      this.browser({ type: "approval", call: job.number, task: call.task })
      this.trace("awaiting_specific_approval", { call: job.number })
    }
    this.pump()
  }

  approve(number: number) {
    const job = [...this.jobs.values()].find(job => job.number === number)
    if (!this.options.real || this.realUsed || !job
      || job.state !== "queued" || this.ended) {
      throw new Error("Invalid approval")
    }
    job.approved = true
    this.trace("specific_request_approved", { call: job.number })
    this.pump()
  }

  private cancel(id: string) {
    if (this.cancelled.size >= 256) throw new Error("Cancel limit")
    this.cancelled.add(id)
    const job = this.jobs.get(id)
    this.trace("provider_cancel", { call: job?.number ?? 0,
      alreadySent: job?.state === "sent" })
    if (!job) return
    job.task = ""
    job.state = "cancelled"
    job.abort.abort()
    this.browser({ type: "settled", call: job.number })
    this.pump()
  }

  private pump() {
    if (this.ended || this.active) return
    const job = [...this.jobs.values()].find(job => job.state === "queued")
    if (!job) return
    if (this.options.real && !this.realUsed && !job.approved) return
    this.active = job
    job.state = "running"
    const real = !!this.options.real && !this.realUsed
    if (real) this.realUsed = true
    this.trace("task_started", { call: job.number, real })
    this.running = this.run(job, real).finally(() => {
      this.active = undefined
      // Do not retain private task text after settlement.
      job.task = ""
      try { this.pump() } catch { this.stop("task_dispatch_failed") }
    })
  }

  private async run(job: Job, real: boolean) {
    let result: string
    let failed = false
    try {
      if (real) {
        result = await this.options.real!(job.task, job.abort.signal)
      } else if (this.options.real) {
        result = "No work performed: the one real-run allowance was used."
      } else {
        await new Promise<void>((resolve, reject) => {
          const cancel = () => {
            clearTimeout(timer)
            reject(new Error("Cancelled"))
          }
          const timer = setTimeout(() => {
            job.abort.signal.removeEventListener("abort", cancel)
            resolve()
          }, this.options.fakeDelayMs ?? 20000)
          job.abort.signal.addEventListener("abort", cancel, { once: true })
        })
        result = "Simulation complete. The example status is green. "
          + "No real action was performed."
      }
      if (!result.trim()
        || Buffer.byteLength(result) > MAX_RESULT_BYTES + 32) {
        throw new Error("Invalid summary")
      }
    } catch {
      failed = true
      result = "Backend stopped or failed. Actions may have occurred; "
        + "verify actual state before retrying."
    }
    if (this.ended || job.abort.signal.aborted) return
    try {
      this.trace("task_settled", { call: job.number, failed })
      this.send(toolResult(job.id, result))
      job.state = "sent"
      this.trace("result_sent_unacknowledged", { call: job.number })
      this.browser({ type: "settled", call: job.number })
    } catch { this.stop("result_delivery_uncertain") }
  }

  async idle() {
    while (this.active) await this.running
  }

  stop(code: string) {
    if (this.ended) return
    this.ended = true
    this.ready = false
    clearTimeout(this.timer)
    for (const job of this.jobs.values()) {
      job.abort.abort()
      job.task = ""
    }
    try {
      this.trace(code)
      this.browser({ type: "ended", code })
    } catch { /* A lost browser cannot receive the final diagnostic. */ }
    this.options.close()
  }
}
