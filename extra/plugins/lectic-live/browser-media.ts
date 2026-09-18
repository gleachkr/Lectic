import type { PCMPlayer } from "./gemini-audio"

export type MediaOptions = {
  token: string
  command(path: string, body?: object): Promise<{
    sdp?: string; sessionId: string; idleTimeout: number
  }>
  stream(stream: MediaStream): void
  lost(reason?: string): void
}
export type BrowserMedia = {
  start(media: MediaStream): Promise<{
    sessionId: string; idleTimeout: number
  }>
  pause(): void
  resume(): void
  unlock(): void
  close(): void
}

// Self-contained factories are embedded alongside the shared page lifecycle.
export function createOpenAIMedia(options: MediaOptions): BrowserMedia {
  let peer: RTCPeerConnection | undefined
  let outgoing: MediaStream | undefined
  let closed = false
  let paused = false
  let bootstrapped = false
  const bootstrap: string[] = []
  let rejectStarted: ((error: Error) => void) | undefined
  let disconnectTimer: ReturnType<typeof setTimeout> | undefined
  const lost = () => { if (!closed && !paused) options.lost() }
  return {
    async start(media) {
      outgoing = media.clone()
      outgoing.getAudioTracks().forEach(track => { track.enabled = false })
      peer = new RTCPeerConnection()
      for (const track of outgoing.getTracks()) peer.addTrack(track, outgoing)
      peer.ontrack = event => {
        if (closed || paused) return
        options.stream(event.streams[0] ?? new MediaStream([event.track]))
      }
      peer.onconnectionstatechange = () => {
        if (closed || paused) return
        clearTimeout(disconnectTimer)
        if (peer?.connectionState === "failed") lost()
        if (peer?.connectionState === "disconnected") {
          disconnectTimer = setTimeout(lost, 3000)
        }
      }
      const channel = peer.createDataChannel("oai-events")
      channel.onclose = channel.onerror = lost
      const startup = new Promise<void>((resolve, reject) => {
        rejectStarted = reject
        channel.onmessage = event => {
          if (closed || paused || bootstrapped
            || typeof event.data !== "string") return
          if (event.data.length > 64 * 1024 || bootstrap.length >= 128) {
            reject(new Error("Bootstrap event limit exceeded"))
            lost()
            return
          }
          bootstrap.push(event.data)
          try {
            if (JSON.parse(event.data).type === "session.started") resolve()
          } catch { reject(new Error("Invalid Live event")) }
        }
      })
      void startup.catch(() => {})
      const check = () => {
        if (closed || paused) throw new Error("Startup cancelled")
      }
      const offer = await peer.createOffer()
      check()
      await peer.setLocalDescription(offer)
      check()
      const response = await options.command("/start", { sdp: offer.sdp })
      check()
      await peer.setRemoteDescription({ type: "answer", sdp: response.sdp })
      check()
      const timer = setTimeout(() => rejectStarted?.(
        new Error("Timed out waiting for session.started"),
      ), 10_000)
      try { await startup } finally { clearTimeout(timer) }
      check()
      await options.command("/ready", { events: bootstrap })
      bootstrap.splice(0)
      bootstrapped = true
      check()
      return response
    },
    pause() {
      paused = true
      clearTimeout(disconnectTimer)
      outgoing?.getAudioTracks().forEach(track => { track.enabled = false })
      rejectStarted?.(new Error("Session ended during startup"))
    },
    resume() {
      paused = false
      if (!closed && bootstrapped) {
        outgoing?.getAudioTracks().forEach(track => { track.enabled = true })
      }
    },
    unlock() {},
    close() {
      closed = true
      clearTimeout(disconnectTimer)
      rejectStarted?.(new Error("Session ended during startup"))
      peer?.close()
      outgoing?.getTracks().forEach(track => track.stop())
    },
  }
}

export function createGeminiMedia(
  options: MediaOptions, Player: typeof PCMPlayer,
): BrowserMedia {
  let context: AudioContext | undefined
  let capture: AudioWorkletNode | undefined
  let source: MediaStreamAudioSourceNode | undefined
  let bridge: MediaStreamAudioDestinationNode | undefined
  let socket: WebSocket | undefined
  let player: PCMPlayer | undefined
  let closed = false
  let enabled = false
  let ready = false
  let capturing = false
  let failed = false
  let epoch = 0
  let rejectWait: ((error: Error) => void) | undefined
  let running: (() => void) | undefined
  const check = () => {
    if (closed) throw new Error("Startup cancelled")
  }
  function fail(code: string, detail?: object) {
    if (closed || failed) return
    failed = true
    console.log("Lectic Live: browser audio failure", { code, ...detail })
    options.lost(code)
  }
  function captureMode(active: boolean) {
    if (active === capturing) return
    capturing = active
    // Retire transferable frames queued before pause/suspension. A reset
    // of the framer tail alone cannot invalidate main-thread port events.
    epoch++
    capture?.port.postMessage({ type: active ? "start" : "stop", epoch })
  }
  function synchronize() {
    if (closed) return
    const active = context?.state === "running"
    captureMode(!!(enabled && ready && active))
    if (!active) {
      player?.flush()
      console.log("Lectic Live: audio suspended; click anywhere or press "
        + "a key to resume. Audio while suspended is discarded, not queued.")
    } else running?.()
  }
  return {
    async start(media) {
      context = new AudioContext()
      context.onstatechange = synchronize
      // Permission alone may not unlock WebAudio. Wait before paid startup.
      if (context.state !== "running") {
        console.log("Lectic Live: audio autoplay blocked; click anywhere "
          + "or press a key to enable audio.")
        await new Promise<void>((resolve, reject) => {
          running = resolve
          rejectWait = reject
          void context!.resume().then(synchronize).catch(() => {})
        })
        running = undefined
      }
      check()
      await context.audioWorklet.addModule("/worklet.js")
      check()
      bridge = context.createMediaStreamDestination()
      // One audible path through the page's audio element; the bridge also
      // feeds local analysis of actually scheduled, not merely queued audio.
      player = new Player(context, bridge)
      capture = new AudioWorkletNode(context, "lectic-pcm", {
        channelCount: 1, channelCountMode: "explicit",
        outputChannelCount: [1],
      })
      source = context.createMediaStreamSource(media)
      source.connect(capture)
      capture.connect(context.destination) // Worklet output is silence.
      capture.port.onmessage = event => {
        if (closed) return
        const frame = event.data
        if (!(frame?.pcm instanceof ArrayBuffer)
          || !Number.isSafeInteger(frame.epoch)) {
          fail(frame?.type === "overload"
            ? "capture_overload" : "invalid_capture_frame")
          return
        }
        capture!.port.postMessage("ack")
        if (!capturing || frame.epoch !== epoch
          || context!.state !== "running") return
        if (socket?.readyState !== WebSocket.OPEN
          || socket.bufferedAmount + frame.pcm.byteLength > 192000) {
          fail("capture_transport_unavailable_or_overloaded")
          return
        }
        try { socket.send(frame.pcm) } catch { fail("capture_send_failed") }
      }
      socket = new WebSocket(`ws://${location.host}/socket`, [
        "lectic-live-pcm", `auth.${options.token}`,
      ])
      socket.binaryType = "arraybuffer"
      const connected = new Promise<void>((resolve, reject) => {
        rejectWait = reject
        socket!.onopen = () => resolve()
      })
      socket.onclose = () => {
        rejectWait?.(new Error("Local audio connection lost"))
        fail("local_socket_closed")
      }
      socket.onerror = () => {
        rejectWait?.(new Error("Local audio connection failed"))
        fail("local_socket_error")
      }
      socket.onmessage = event => {
        if (closed) return
        try {
          if (event.data instanceof ArrayBuffer) {
            // Suspended contexts must not accumulate speech for later replay.
            if (enabled && ready && context!.state === "running") {
              player!.play(event.data)
            }
          } else if (event.data === '{"type":"flush"}') player!.flush()
          else throw new Error("Invalid local audio control")
        } catch (error) {
          if (error instanceof Error
            && error.message === "Playback overload") {
            const detail = error as Error & {
              queuedSeconds: number; scheduledSources: number
            }
            fail("playback_overload", {
              queuedSeconds: detail.queuedSeconds,
              scheduledSources: detail.scheduledSources,
            })
          } else fail("invalid_playback_or_local_control")
        }
      }
      const timer = setTimeout(() => rejectWait?.(
        new Error("Local audio startup timed out"),
      ), 15000)
      try { await connected } finally { clearTimeout(timer) }
      check()
      const response = await options.command("/start", {
        rate: context.sampleRate,
      })
      check()
      options.stream(bridge.stream)
      await options.command("/ready", { events: [] })
      check()
      ready = true
      console.log(`Lectic Live: PCM input ${context.sampleRate} Hz; `
        + "output 24000 Hz. No audio recording.")
      return response
    },
    pause() {
      enabled = false
      captureMode(false)
      player?.flush()
    },
    resume() { enabled = true; synchronize() },
    unlock() {
      if (!closed) void context?.resume().then(synchronize).catch(() => {})
    },
    close() {
      if (closed) return
      closed = true
      rejectWait?.(new Error("Session ended during startup"))
      captureMode(false)
      capture?.disconnect()
      capture?.port.close()
      source?.disconnect()
      player?.flush()
      bridge?.disconnect()
      bridge?.stream.getTracks().forEach(track => track.stop())
      if (context) {
        context.onstatechange = null
        void context.close().catch(() => {})
      }
      socket?.close()
    },
  }
}
