// Self-contained functions: embedded in the browser bundle via toString().
export function createIdleState(timeoutMs: number, now: number) {
  let lastActivity = now
  let baseline: number | undefined
  let previous = now
  let mode: "waiting" | "active" | "sleeping" = "waiting"
  return {
    mode(value: typeof mode, at: number) {
      mode = value
      lastActivity = at
    },
    activity(at: number) {
      if (mode === "active") lastActivity = at
    },
    sample(at: number, mic: number, agent: number, busy: boolean) {
      // Compare against a slowly adapting ambient RMS, not absolute volume.
      // A floor rejects tiny digital noise; the ratio tolerates steady fans.
      const changed = baseline !== undefined
        && Math.abs(mic - baseline)
          > Math.max(0.012, Math.min(mic, baseline) * 1.5)
      const dt = Math.max(0, at - previous)
      baseline = baseline === undefined ? mic
        : baseline + (mic - baseline) * (1 - Math.exp(-dt / 500))
      previous = at
      if (mode === "waiting") return { dim: 1, idle: false, wake: false }
      if (mode === "sleeping") {
        return { dim: 1, idle: false, wake: changed }
      }
      if (changed || agent > 0.008 || busy) lastActivity = at
      const quiet = Math.max(0, at - lastActivity)
      return {
        dim: Math.min(1, Math.max(0, quiet * 2 / timeoutMs - 1)),
        idle: quiet >= timeoutMs, wake: false,
      }
    },
    recalibrate(at: number) {
      baseline = undefined
      previous = at
      lastActivity = at
    },
  }
}

export function createIdleMonitor(
  makeState: typeof createIdleState,
  timeoutSeconds: number,
  callbacks: { dim(value: number): void; idle(): void; wake(): void },
) {
  const state = makeState(timeoutSeconds * 1000, performance.now())
  const context = new AudioContext()
  const mic = context.createAnalyser()
  const agent = context.createAnalyser()
  mic.fftSize = agent.fftSize = 2048
  const samples = new Float32Array(2048)
  let microphone: MediaStreamAudioSourceNode | undefined
  let remote: MediaStreamAudioSourceNode | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let stopped = false
  let busy = false
  function level(analyser: AnalyserNode) {
    analyser.getFloatTimeDomainData(samples)
    let sum = 0
    for (const value of samples) sum += value * value
    return Math.sqrt(sum / samples.length)
  }
  function tick() {
    if (stopped) return
    const now = performance.now()
    if (context.state === "running") {
      const result = state.sample(now, level(mic), level(agent), busy)
      callbacks.dim(result.dim)
      if (result.idle) {
        state.mode("sleeping", now)
        callbacks.idle()
      } else if (result.wake) {
        state.mode("waiting", now)
        callbacks.wake()
      }
    } else {
      // No analysis means no safe idle decision or synthetic wake event.
      state.recalibrate(now)
    }
    if (!stopped) timer = setTimeout(tick, 50)
  }
  function resume() {
    if (stopped || context.state === "running") return
    console.log("Lectic Live: wake detection suspended; click anywhere "
      + "or press a key to enable microphone analysis.")
    void context.resume().catch(() => {})
  }
  tick()
  return {
    attachMic(stream: MediaStream) {
      microphone?.disconnect()
      microphone = context.createMediaStreamSource(stream)
      microphone.connect(mic)
      // Analysis only. Never route the local microphone to the speakers.
      resume()
    },
    attachAgent(stream?: MediaStream) {
      remote?.disconnect()
      remote = stream ? context.createMediaStreamSource(stream) : undefined
      remote?.connect(agent)
    },
    mode(value: "waiting" | "active" | "sleeping") {
      state.mode(value, performance.now())
    },
    activity() { state.activity(performance.now()) },
    busy(value: boolean) { busy = value },
    resume,
    stop() {
      if (stopped) return
      stopped = true
      clearTimeout(timer)
      microphone?.disconnect()
      remote?.disconnect()
      mic.disconnect()
      agent.disconnect()
      void context.close().catch(() => {})
    },
  }
}
