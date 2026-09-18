import {
  createOpenAIMedia, createGeminiMedia, type BrowserMedia, type MediaOptions,
} from "./browser-media"
import { PCMPlayer } from "./gemini-audio"
import { createIdleMonitor, createIdleState } from "./idle"
import { createVisualizer, visualizerLicense } from "./visualizer"

// Browser code is typechecked here and embedded after transpilation. No
// relative files or runtime source-tree paths are needed by script bundles.
function browserMain(
  makeVisualizer: typeof createVisualizer,
  makeIdleMonitor: typeof createIdleMonitor,
  makeIdleState: typeof createIdleState,
  makeMedia: (options: MediaOptions) => BrowserMedia,
  notice: string,
  recoverable = false,
) {
  const audio = document.getElementById("audio") as HTMLAudioElement
  const canvas = document.getElementById("visualizer") as HTMLCanvasElement
  const token = location.hash.slice(1)
  history.replaceState(null, "", "/")
  const visualizer = makeVisualizer(canvas)
  let transport: BrowserMedia | undefined
  let media: MediaStream | undefined
  let idle: ReturnType<typeof createIdleMonitor> | undefined
  let connection: "starting" | "active" | "closing" | "sleeping"
    = "starting"
  let sessionId = ""
  let wakeRequested = false
  let ended = false
  let finishing = false
  let leaving = false
  let pollTimer: ReturnType<typeof setTimeout> | undefined

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
    transport?.pause()
    audio.pause()
    visualizer.stop()
    clearTimeout(pollTimer)
    window.removeEventListener("click", unlockAudio)
    window.removeEventListener("keydown", unlockAudio)
  }
  function release() {
    silence()
    transport?.close()
    audio.srcObject = null
  }
  async function finish(reason = "controller_ended") {
    if (finishing) return
    finishing = true
    console.log("Lectic Live: stopping", { reason })
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
        reportDiagnostics(state.diagnostics)
        console.log("Lectic Live: final state", {
          phase: state.phase, lifecycle: state.lifecycle,
        })
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
    transport?.unlock()
    void playback()
  }
  window.addEventListener("click", unlockAudio)
  window.addEventListener("keydown", unlockAudio)

  async function sleep(path = "/idle") {
    if (ended || connection !== "active") return
    connection = "closing"
    idle?.mode("sleeping")
    transport?.pause()
    audio.pause()
    try {
      const result = await command(path, { sessionId })
      if (ended) return
      if (!result.idle) {
        // A delegation or transcript may have arrived after the last poll.
        const state = await command("/state")
        if (ended) return
        if (state.ending) { await finish(); return }
        connection = "active"
        wakeRequested = false
        idle?.mode("active")
        transport?.resume()
        await playback()
        return
      }
      transport?.close()
      transport = undefined
      audio.srcObject = null
      visualizer.detach()
      idle?.attachAgent()
      connection = "sleeping"
      idle?.mode("sleeping")
      console.log("Lectic Live: disconnected; microphone wake is local. "
        + (recoverable ? "Speak to start a fresh, text-seeded session. "
          + "Final provider usage is unconfirmed; no audio is replayed."
          : "Paid session closed; speak to resume."))
      if (wakeRequested) { wakeRequested = false; void start() }
    } catch { await finish("disconnect_or_recovery_failed") }
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
    console.log(notice)
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
      const next = makeMedia({ token, command,
        stream(stream) {
          if (ended || transport !== next || connection === "closing") return
          audio.srcObject = stream
          visualizer.attach(stream)
          idle?.attachAgent(stream)
          void playback()
        },
        lost: reason => {
          if (transport !== next || ended) return
          console.log("Lectic Live: transport lost", {
            reason: reason ?? "media_connection_lost",
          })
          if (recoverable && connection === "active") {
            void sleep("/recover")
          } else if (connection !== "closing" && connection !== "sleeping") {
            void finish(reason ?? "media_connection_lost")
          }
        },
      })
      transport = next
      const response = await next.start(media)
      if (ended) { release(); return }
      sessionId = response.sessionId
      media.getAudioTracks().forEach(track => { track.enabled = true })
      transport.resume()
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
        await finish("startup_failed")
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
    void fetch("/close", {
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
  function reportDiagnostics(events: { sequence: number }[]) {
    for (const event of events) {
      if (event.sequence <= lastDiagnostic) continue
      console.log("Lectic Live: lifecycle", event)
      lastDiagnostic = event.sequence
    }
  }
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
      reportDiagnostics(state.diagnostics)
      if (state.ending) { await finish(); return }
      if (recoverable && state.sleeping && connection === "active"
        && state.sessionId === sessionId) {
        await sleep("/recover")
      }
    } catch {
      if (ended) return
      console.log("Lectic Live: local controller unavailable; stopping.")
      await finish("controller_unavailable")
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

function script(factory: string, notice: string, recoverable = false) {
  return visualizerLicense + `\n(${browserMain.toString()})(
    ${createVisualizer.toString()},
    ${createIdleMonitor.toString()},
    ${createIdleState.toString()},
    ${factory}, ${JSON.stringify(notice)}, ${recoverable}
  );`
}
export const browserScript = script(createOpenAIMedia.toString(),
  "Lectic Live: starting automatically. Voice is billable at approximately "
  + "$0.05/minute with a 15-second minimum; backend costs are separate. "
  + "Close this tab or use Ctrl-C to stop.")
export const geminiBrowserScript = script(
  `(options) => (${createGeminiMedia.toString()})(
    options, ${PCMPlayer.toString()})`,
  "Lectic Live: Gemini audio-only preview. No delegation. "
  + "After idle or connection loss, speak to start a text-seeded session. "
  + "Voice is billable; elapsed time is not a spending cap. "
  + "Close this tab or Ctrl-C to stop.", true)
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
