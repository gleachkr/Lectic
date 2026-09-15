import { createIdleMonitor, createIdleState } from "./idle"
import { createVisualizer, visualizerLicense } from "./visualizer"

// Browser code is typechecked here and embedded after transpilation. No
// relative files or runtime source-tree paths are needed by script bundles.
function browserMain(
  makeVisualizer: typeof createVisualizer,
  makeIdleMonitor: typeof createIdleMonitor,
  makeIdleState: typeof createIdleState,
) {
  const audio = document.getElementById("audio") as HTMLAudioElement
  const canvas = document.getElementById("visualizer") as HTMLCanvasElement
  const token = location.hash.slice(1)
  history.replaceState(null, "", "/")
  const visualizer = makeVisualizer(canvas)
  let peer: RTCPeerConnection | undefined
  let media: MediaStream | undefined
  let outgoing: MediaStream | undefined
  let idle: ReturnType<typeof createIdleMonitor> | undefined
  let connection: "starting" | "active" | "closing" | "sleeping"
    = "starting"
  let sessionId = ""
  let wakeRequested = false
  let ended = false
  let finishing = false
  let leaving = false
  let disconnectTimer: ReturnType<typeof setTimeout> | undefined
  let pollTimer: ReturnType<typeof setTimeout> | undefined
  let bootstrapped = false
  let bootstrap: string[] = []
  let rejectStarted: ((error: Error) => void) | undefined

  async function command(path: string, body: object = {}) {
    const response = await fetch(path, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`, "Content-Type": "application/json",
      },
      body: JSON.stringify(body), signal: AbortSignal.timeout(30_000),
    })
    const value = await response.json()
    if (!response.ok) throw new Error(value.error ?? "Controller unavailable")
    return value
  }
  function silence() {
    idle?.stop()
    media?.getTracks().forEach(track => track.stop())
    outgoing?.getTracks().forEach(track => track.stop())
    audio.pause()
    visualizer.stop()
    clearTimeout(disconnectTimer)
    clearTimeout(pollTimer)
    rejectStarted?.(new Error("Session ended during startup"))
    window.removeEventListener("click", unlockAudio)
    window.removeEventListener("keydown", unlockAudio)
  }
  function release() {
    silence()
    peer?.close()
    audio.srcObject = null
  }
  async function finish() {
    if (finishing) return
    finishing = true
    ended = true
    silence()
    try {
      const result = await command("/end")
      console.log("Lectic Live: shutdown", result)
    } catch {
      console.log("Lectic Live: shutdown could not be confirmed. "
        + "The local watchdog will attempt shutdown.")
    } finally { release() }
    if (!leaving) {
      try {
        const state = await command("/state")
        console.log("Lectic Live: final usage", state.usage)
      } catch { console.log("Lectic Live: final usage unavailable.") }
    }
  }
  async function playback() {
    if (ended || !audio.srcObject || connection === "closing"
      || connection === "sleeping") return
    try { await audio.play() } catch {
      if (!ended) console.log("Lectic Live: audio autoplay blocked; "
        + "click anywhere or press a key to enable audio.")
    }
  }
  function unlockAudio() {
    if (ended) return
    visualizer.resume()
    idle?.resume()
    void playback()
  }
  window.addEventListener("click", unlockAudio)
  window.addEventListener("keydown", unlockAudio)

  async function sleep() {
    if (ended || connection !== "active") return
    connection = "closing"
    clearTimeout(disconnectTimer)
    outgoing?.getAudioTracks().forEach(track => { track.enabled = false })
    audio.pause()
    try {
      const result = await command("/idle", { sessionId })
      if (ended) return
      if (!result.idle) {
        // A delegation or transcript may have arrived after the last poll.
        const state = await command("/state")
        if (ended) return
        if (state.ending) { await finish(); return }
        connection = "active"
        wakeRequested = false
        idle?.mode("active")
        outgoing?.getAudioTracks().forEach(track => { track.enabled = true })
        await playback()
        return
      }
      peer?.close()
      peer = undefined
      outgoing?.getTracks().forEach(track => track.stop())
      outgoing = undefined
      audio.srcObject = null
      visualizer.detach()
      idle?.attachAgent()
      connection = "sleeping"
      console.log("Lectic Live: idle; paid session closed. "
        + "Microphone wake detection remains local.")
      if (wakeRequested) { wakeRequested = false; void start() }
    } catch { await finish() }
  }

  function wake() {
    if (ended) return
    if (connection === "closing") wakeRequested = true
    else if (connection === "sleeping") void start()
  }

  async function start() {
    if (ended) return
    connection = "starting"
    idle?.mode("waiting")
    bootstrapped = false
    bootstrap = []
    console.log("Lectic Live: starting automatically. Voice is billable "
      + "at approximately $0.05/minute with a 15-second minimum; backend "
      + "costs are separate. Close this tab or use Ctrl-C to stop.")
    try {
      // Ask for permission before making a billable API request. Tracks stay
      // disabled until both sideband attachment and bootstrap are complete.
      if (!media) {
        media = await navigator.mediaDevices.getUserMedia({ audio: {
          echoCancellation: true, noiseSuppression: true,
        } })
        media.getAudioTracks().forEach(track => { track.enabled = false })
      }
      if (ended) { release(); return }
      // Only the clone is transmitted. The original remains available for
      // local wake detection throughout idle and reconnect startup.
      outgoing = media.clone()
      outgoing.getAudioTracks().forEach(track => { track.enabled = false })
      peer = new RTCPeerConnection()
      const owner = peer
      for (const track of outgoing.getTracks()) peer.addTrack(track, outgoing)
      peer.ontrack = event => {
        if (ended || peer !== owner || connection === "closing") return
        const stream = event.streams[0] ?? new MediaStream([event.track])
        audio.srcObject = stream
        visualizer.attach(stream)
        idle?.attachAgent(stream)
        void playback()
      }
      peer.onconnectionstatechange = () => {
        if (ended || peer !== owner || connection === "closing") return
        clearTimeout(disconnectTimer)
        if (peer?.connectionState === "failed") void finish()
        if (peer?.connectionState === "disconnected") {
          disconnectTimer = setTimeout(() => { void finish() }, 3000)
        }
      }
      const channel = peer.createDataChannel("oai-events")
      const channelLost = () => {
        if (!ended && peer === owner && connection !== "closing") {
          void finish()
        }
      }
      channel.onclose = channelLost
      channel.onerror = channelLost
      const startup = new Promise<void>((resolve, reject) => {
        const started = resolve
        channel.onmessage = event => receiveBootstrap(event, started)
        rejectStarted = reject
      })
      // Avoid an unhandled rejection while HTTP session creation is pending.
      void startup.catch(() => {})
      function receiveBootstrap(
        event: MessageEvent, started: () => void,
      ) {
        if (ended || peer !== owner || bootstrapped
          || connection === "closing" || typeof event.data !== "string") {
          return
        }
        if (event.data.length > 64 * 1024 || bootstrap.length >= 128) {
          rejectStarted?.(new Error("Bootstrap event limit exceeded"))
          void finish()
          return
        }
        bootstrap.push(event.data)
        try {
          if (JSON.parse(event.data).type === "session.started") started?.()
        } catch { rejectStarted?.(new Error("Invalid Live event")) }
      }
      const offer = await peer.createOffer()
      if (ended) return
      await peer.setLocalDescription(offer)
      if (ended) return
      const response = await command("/start", { sdp: offer.sdp })
      if (ended) { release(); return }
      sessionId = response.sessionId
      await peer.setRemoteDescription({ type: "answer", sdp: response.sdp })
      if (ended) return
      const timer = setTimeout(() => rejectStarted?.(
        new Error("Timed out waiting for session.started"),
      ), 10_000)
      try { await startup } finally { clearTimeout(timer) }
      if (ended) return
      await command("/ready", { events: bootstrap })
      bootstrap = []
      bootstrapped = true
      if (ended) { release(); return }
      media.getAudioTracks().forEach(track => { track.enabled = true })
      outgoing.getAudioTracks().forEach(track => { track.enabled = true })
      if (!idle) {
        idle = makeIdleMonitor(makeIdleState, response.idleTimeout, {
          dim: value => visualizer.dim(value),
          idle: () => { void sleep() }, wake,
        })
        idle.attachMic(media)
        if (audio.srcObject) idle.attachAgent(audio.srcObject as MediaStream)
      }
      connection = "active"
      idle.mode("active")
    } catch (error) {
      if (!ended) {
        console.log("Lectic Live:", error instanceof Error ? error.message
          : "Unable to start voice session")
        await finish()
      }
    }
  }
  window.addEventListener("pagehide", () => {
    leaving = true
    ended = true
    finishing = true
    release()
    if (!token) return
    // Authenticated keepalive, not an unauthenticated beacon endpoint.
    // The heartbeat watchdog covers crashes where pagehide never fires.
    void fetch("/end", {
      method: "POST", keepalive: true,
      headers: {
        Authorization: `Bearer ${token}`, "Content-Type": "application/json",
      },
      body: "{}",
    }).catch(() => {})
  })
  let lastStatus = ""
  let lastCaption = 0
  let lastDiagnostic = 0
  async function poll() {
    if (ended) return
    try {
      const state = await command("/state")
      if (ended) return
      idle?.busy(state.busy)
      const status = JSON.stringify({
        phase: state.phase, backend: state.backend,
        runs: state.runs, tasks: state.tasks,
      })
      if (status !== lastStatus) {
        console.log("Lectic Live: status", JSON.parse(status))
        lastStatus = status
      }
      for (const caption of state.captions) {
        if (caption.sequence <= lastCaption) continue
        if (caption.text.trim()) idle?.activity()
        console.log(`${caption.speaker}:`, caption.text)
        lastCaption = caption.sequence
      }
      for (const event of state.diagnostics) {
        if (event.sequence <= lastDiagnostic) continue
        console.log("Lectic Live: lifecycle", event)
        lastDiagnostic = event.sequence
      }
      if (state.ending) { await finish(); return }
    } catch {
      if (ended) return
      console.log("Lectic Live: local controller unavailable; stopping.")
      await finish()
    }
    if (!ended) pollTimer = setTimeout(() => { void poll() }, 500)
  }
  if (!token) {
    console.log("Lectic Live: open the private URL printed by lectic live. "
      + "Reloading does not resume a paid session.")
    ended = true
    release()
  } else {
    void poll()
    void start()
  }
}

export const browserScript = visualizerLicense
  + `\n(${browserMain.toString()})(
    ${createVisualizer.toString()},
    ${createIdleMonitor.toString()},
    ${createIdleState.toString()}
  );`
export const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Lectic Live</title>
<link rel="stylesheet" href="/style.css">
<script src="/app.js" defer></script>
</head>
<body><main>
<canvas id="visualizer" role="img"
  aria-label="Agent audio visualization"></canvas>
</main><audio id="audio" autoplay playsinline hidden></audio></body></html>`

export const style = `
:root { color-scheme: light; background: #fff; color: #000; }
body { margin: 0; }
main { height: 100vh; height: 100dvh; display: grid; place-items: center; }
canvas { display: block; width: min(80vmin, 640px);
  height: min(80vmin, 640px); }
`
