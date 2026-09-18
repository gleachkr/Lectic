import { PCMPlayer } from "../gemini-audio"

const byId = (id: string) => document.getElementById(id)!
const start = byId("start") as HTMLButtonElement
const stop = byId("stop") as HTMLButtonElement
const status = byId("status")
const transcript = byId("transcript")
const trace = byId("trace")
const approvals = byId("approvals")
const secret = location.hash.slice(1)
history.replaceState(null, "", location.pathname)
let socket: WebSocket | undefined
let context: AudioContext | undefined
let stream: MediaStream | undefined
let capture: AudioWorkletNode | undefined
let source: MediaStreamAudioSourceNode | undefined
let player: PCMPlayer | undefined
let heartbeat: ReturnType<typeof setInterval> | undefined
let ended = false
const records: unknown[] = []

function line(parent: HTMLElement, text: string) {
  const node = document.createElement("div")
  node.textContent = text
  parent.append(node)
  while (parent.childNodes.length > 200) parent.firstChild!.remove()
}
function send(value: unknown) {
  if (socket?.readyState !== WebSocket.OPEN) {
    throw new Error("Local connection closed")
  }
  socket.send(JSON.stringify(value))
}
function end(reason: string) {
  if (ended) return
  ended = true
  status.textContent = reason
  start.disabled = true
  stop.disabled = true
  clearInterval(heartbeat)
  capture?.port.postMessage("stop")
  capture?.disconnect()
  capture?.port.close()
  source?.disconnect()
  stream?.getTracks().forEach(track => track.stop())
  player?.flush()
  void context?.close().catch(() => {})
  socket?.close()
  approvals.replaceChildren()
}

start.onclick = async () => {
  start.disabled = true
  try {
    // Resume immediately in the click gesture, before permission/network IO.
    const rate = Number((byId("rate") as HTMLSelectElement).value)
    context = new AudioContext(rate ? { sampleRate: rate } : {})
    await context.resume()
    stream = await navigator.mediaDevices.getUserMedia({ audio: {
      channelCount: 1, echoCancellation: true, noiseSuppression: true,
    } })
    if (ended) {
      stream.getTracks().forEach(track => track.stop())
      return
    }
    await context.audioWorklet.addModule("/worklet.js")
    if (ended) return
    player = new PCMPlayer(context)
    capture = new AudioWorkletNode(context, "lectic-pcm", {
      channelCount: 1, channelCountMode: "explicit", outputChannelCount: [1],
    })
    source = context.createMediaStreamSource(stream)
    source.connect(capture)
    capture.connect(context.destination)
    capture.port.onmessage = event => {
      if (ended) return
      if (!(event.data instanceof ArrayBuffer)
        || !socket || socket.readyState !== WebSocket.OPEN
        || socket.bufferedAmount > 192000) {
        end("Capture or local socket overload; relaunch explicitly")
        return
      }
      socket.send(event.data)
      capture!.port.postMessage("ack")
    }
    socket = new WebSocket(`ws://${location.host}/socket`, [
      "lectic-gemini-spike", `auth.${secret}`,
    ])
    socket.binaryType = "arraybuffer"
    socket.onopen = () => {
      send({ type: "start", rate: context!.sampleRate })
      status.textContent = "Setting up; actual input "
        + `${context!.sampleRate} Hz`
      heartbeat = setInterval(() => {
        try { send({ type: "ping" }) } catch { end("Local connection lost") }
      }, 2000)
    }
    socket.onmessage = event => {
      try {
        if (event.data instanceof ArrayBuffer) {
          player!.play(event.data)
          return
        }
        const message = JSON.parse(event.data)
        switch (message.type) {
          case "ready":
            status.textContent = `Ready; actual input ${message.rate} Hz`
            capture!.port.postMessage("start")
            break
          case "flush": player!.flush(); break
          case "ended": end(`Ended: ${message.code}`); break
          case "trace":
            records.push(message)
            if (records.length > 2000) records.shift()
            line(trace, JSON.stringify(message))
            break
          case "transcript":
            // JSON escaping exposes exact whitespace/repeated fragments.
            // These are local receipt observations, not inferred turns.
            line(transcript, `Receipt ${message.receipt} ${message.speaker}: `
              + JSON.stringify(message.text))
            break
          case "approval": {
            const item = document.createElement("div")
            item.id = `call-${message.call}`
            const task = document.createElement("pre")
            task.textContent = message.task
            const button = document.createElement("button")
            button.textContent = "Authorize this one real Lectic request"
            button.onclick = () => {
              button.disabled = true
              send({ type: "approve", call: message.call })
            }
            item.append(task, button)
            approvals.append(item)
            break
          }
          case "settled": byId(`call-${message.call}`)?.remove(); break
        }
      } catch {
        end("Playback or local protocol failure; relaunch explicitly")
      }
    }
    socket.onerror = () => end("Local connection failed")
    socket.onclose = () => end("Connection closed; final usage unknown")
    context.onstatechange = () => {
      if (!ended && context!.state !== "running") {
        end("Audio context suspended; relaunch explicitly")
      }
    }
  } catch {
    end("Microphone, audio, or startup failed; relaunch explicitly")
  }
}
stop.onclick = () => end("Stopped; cancellation is not rollback")
window.addEventListener("pagehide", () => end("Page closed"))
byId("export").onclick = () => {
  const blob = new Blob([JSON.stringify({
    version: 1, note: "Local receipt order; sends are not acknowledgments",
    events: records,
  }, null, 2)], { type: "application/json" })
  const url = URL.createObjectURL(blob)
  const link = document.createElement("a")
  link.href = url
  link.download = "gemini-spike-redacted.json"
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
