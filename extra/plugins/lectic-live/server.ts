import { sendPCM } from "./pcm-relay"
import { LivePromptFailure } from "./config"
import type { ServerWebSocket } from "bun"
import { frameSamples } from "./gemini-audio"
import { workletScript } from "./gemini-worklet"
import { randomBytes, timingSafeEqual } from "node:crypto"
import { Coordinator, type Backend } from "./coordinator"
import { record, text } from "./validation"
import {
  CreationRejected, SessionFailure, Lifecycle, sameOwner,
  type ProviderConnect, type ProviderObservation,
  type ProviderSession, type CloseState,
} from "./provider"
import { html, browserScript, geminiBrowserScript, style } from "./web"
import { Journal, Usage } from "./state"
import { mergeHistory, type History, type HistoryContext } from "./history"

type SocketData = { kind: "audio" | "lifetime" }

export type ServerOptions = {
  provider?: "openai" | "gemini"
  port?: number
  connect: ProviderConnect
  backend: Backend
  maxSessionSeconds?: number
  contextSeconds?: number
  idleTimeout?: number
  heartbeatMs?: number
  watchdogMs?: number
  history?: History
  previousSession?: HistoryContext
}

export function startServer(options: ServerOptions) {
  const pcm = options.provider === "gemini"
  const idleTimeout = options.idleTimeout ?? 30
  if (!Number.isInteger(idleTimeout) || idleTimeout < 1
    || idleTimeout > 3600) throw new Error("Invalid idle timeout")
  const secret = randomBytes(32).toString("hex")
  const startup = new AbortController()
  let phase = "Ready — no paid session started"
  let used = false
  let ending = false
  let confirmed = false
  let ready = false
  let lost = false
  let providerLimit = false
  let parkedSessionId: string | undefined
  let sleeping = false
  let idling = false
  let lifecycle = new Lifecycle()
  let generation = 0
  let idlePromise: Promise<boolean> | undefined
  let completedRuns = 0
  let completedElapsed = 0
  let lastSpeech = 0
  let session: ProviderSession | undefined
  let coordinator: Coordinator | undefined
  let creation: Promise<void> | undefined
  let endPromise: Promise<void> | undefined
  let attached = false
  let stopPromise: Promise<void> | undefined
  let resolveStopped: () => void
  const stopped = new Promise<void>(resolve => { resolveStopped = resolve })
  let heartbeat = Date.now()
  let began = 0
  const usage = new Usage()
  let previousSession = options.previousSession
  let retained = options.previousSession
  const journal = new Journal(options.previousSession?.conversationId, () => {
    const event = journal.snapshot().at(-1)
    options.history?.append("lifecycle", event)
    checkpoint(event?.code === "context_cleared")
  })

  function checkpoint(reset = false) {
    const current = coordinator?.historyContext()
      ?? previousSession ?? {
        version: 1, conversationId: journal.conversationId,
        incomplete: false, fragments: [], tasks: [],
      }
    retained = mergeHistory(reset ? undefined : retained, current)
    options.history?.checkpoint(retained, reset)
  }
  checkpoint()
  const contextMs = (options.contextSeconds ?? 300) * 1000
  let sequence = 0
  const captions: {
    sequence: number; speaker: string; text: string; received: number
  }[] = []
  const buffered: ProviderObservation[] = []
  const seen = new Set<string>()
  const maxSeconds = options.maxSessionSeconds ?? 600
  let origin = ""
  let controls = 0
  let audioOwner: ServerWebSocket<SocketData> | undefined
  let lifetimeOwner: ServerWebSocket<SocketData> | undefined
  let lifetimeReserved = false
  let audioReserved = false
  let rate = 0
  let audioTimer: ReturnType<typeof setTimeout> | undefined
  let audioWindow = 0
  let audioFrames = 0
  let latestTokens: Readonly<Record<string, number>> | undefined

  const previousTokenReports: {
    latest?: Readonly<Record<string, number>>; lifecycle: CloseState
  }[] = []

  let clearOnAttach = false
  let cancelOnAttach = false

  function prune() {
    while (captions.length
      && captions[0].received < Date.now() - contextMs) captions.shift()
    coordinator?.diagnostics()
    checkpoint()
  }

  function receive(event: ProviderObservation) {
    if (!session) {
      if (buffered.length >= 256) throw new Error("Bootstrap overflow")
      buffered.push(event)
      return
    }
    if (!sameOwner(event.owner, session.owner)) {
      throw new Error("Wrong session ownership")
    }
    if (event.type === "transcript" && event.interim) return
    // Adapter identity can join bootstrap/sideband copies. Absence of an
    // identity means a new observation, even when its text repeats.
    const key = event.identity
    if (key && seen.has(key)) return
    if (seen.size >= 8192) {
      journal.add("event_limit")
      void end()
      return
    }
    if (key) seen.add(key)
    // The archive is opt-in and contains transcript text, not raw audio,
    // SDP, API keys, or reflected transport payloads.
    if (event.type !== "error" && event.type !== "diagnostic") {
      options.history?.append("event", event)
    }
    if (!ending && event.type === "transcript") {
      lastSpeech = Date.now()
      captions.push({
        sequence: ++sequence,
        speaker: event.speaker === "user" ? "You"
          : pcm ? "Gemini Live" : "GPT-Live",
        text: event.text, received: Date.now(),
      })
      while (captions.length > 96
        || Buffer.byteLength(JSON.stringify(captions)) > 20_000) {
        captions.shift()
      }
    } else if (event.type === "usage") {
      lifecycle.observe({ transport: "open", remote: "unknown",
        usage: event.completeness })
      if (event.unit === "seconds") {
        usage.update(event.seconds, event.completeness === "final")
      }
      if (event.unit === "tokens") latestTokens = event.counters
      if (!pcm && usage.snapshot(used).estimatedBillableSeconds >= maxSeconds
        && !ending) {
        journal.add("budget_reached")
        void end()
      }
    } else if (event.type === "lifecycle") {
      observeClose(event.state)
      if (event.state.remote === "ended" && !idling) void end()
    } else if (event.type === "diagnostic") {
      journal.add("provider_diagnostic", undefined, event.detail)
    } else if (event.type === "error") {
      providerLimit ||= event.reason === "provider_limit"
      journal.add(event.reason ?? "live_error", undefined, event.detail)
      phase = "Live reported an error; closing session"
      if (pcm && ready && !ending) void sleep()
      else void end()
    }
    // Drain final transcripts, but never launch work during an idle close.
    if (!ending && !lost
      && (event.type === "transcript"
        || event.type === "cancel"
        || (event.type === "request" && !idling))) {
      coordinator?.receive(event)
    }
  }

  function observeClose(state: CloseState) {
    lifecycle.observe(state)
    const current = lifecycle.snapshot()
    // Preserve OpenAI's existing idle/accounting gate, without conflating
    // it with transport closure or requiring synthetic terminal events.
    confirmed = current.remote === "ended" && current.usage === "final"
  }

  function disconnected() {
    if (lost || confirmed || idling || sleeping) return
    lost = true
    lifecycle.observe({ transport: "closed", remote: "unknown",
      usage: "unknown" })
    journal.add(pcm ? "transport_lost" : "sideband_lost")
    phase = "Provider connection lost — closing session"
    coordinator?.stop()
    if (pcm && ready && !ending) void sleep()
    else void end()
  }

  function elapsed() {
    return completedElapsed + (began ? (Date.now() - began) / 1000 : 0)
  }

  async function sleep() {
    if (idlePromise) return idlePromise
    idling = true
    if (pcm) coordinator?.stop()
    ready = false
    phase = "Disconnecting session before microphone wake"
    idlePromise = (async () => {
      try {
        const closeState = await session!.close()
        observeClose(closeState)
        const closed = pcm ? closeState.transport === "closed" : confirmed
        if (!closed || ending) {
          if (!closed) journal.add("finalization_uncertain")
          void end()
          return false
        }
        coordinator?.stop()
        await coordinator?.idle()
        if (ending) return false
        checkpoint()
        previousSession = retained
        completedRuns += coordinator?.runs ?? 0
        completedElapsed = elapsed()
        began = 0
        // Retire callbacks before dropping the old owner and bootstrap IDs.
        generation++
        parkedSessionId = session!.owner.sessionId
        if (pcm) {
          clearTimeout(audioTimer)
          const oldAudio = audioOwner
          audioOwner = undefined
          oldAudio?.close(1000)
          if (oldAudio) setTimeout(() => oldAudio.terminate(), 250).unref()
          audioReserved = false
          audioFrames = 0
          audioWindow = 0
        }
        coordinator = undefined
        session = undefined
        creation = undefined
        sleeping = true
        journal.add("idle_disconnected")
        phase = "Disconnected; microphone wake detection is local"
          + (pcm ? "; final provider usage unconfirmed" : "")
        return true
      } catch {
        journal.add("finalization_uncertain")
        void end()
        return false
      } finally { idling = false }
    })()
    return idlePromise
  }

  async function end() {
    if (endPromise) return endPromise
    ending = true
    ready = false
    startup.abort()
    clearTimeout(audioTimer)
    audioOwner?.close(1000)
    const closingAudio = audioOwner
    if (closingAudio) {
      setTimeout(() => closingAudio.terminate(), 250).unref()
    }
    coordinator?.stop()
    endPromise = (async () => {
      await creation?.catch(() => {})
      coordinator?.stop()
      try {
        if (session) observeClose(await session.close())
      } catch { journal.add("finalization_uncertain") }
      await coordinator?.idle()
      completedElapsed = elapsed()
      began = 0
      journal.add(confirmed || !used ? "ended" : "finalization_uncertain")
      phase = pcm && used
        ? (providerLimit ? "Ended — Gemini provider connection limit. "
          : "Ended — Gemini transport stopped locally. ")
          + "Final usage unconfirmed; relaunch explicitly."
        : confirmed ? "Ended — final usage confirmed"
          : used ? "Ended — session finalization/usage unconfirmed"
            : "Ended — no session created"
    })()
    return endPromise
  }

  const headers = {
    "Content-Security-Policy": "default-src 'none'; script-src 'self'; "
      + "style-src 'self'; connect-src 'self'; media-src 'self' blob:; "
      + "worker-src 'self'; "
      + "base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
    "Referrer-Policy": "no-referrer",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Permissions-Policy": "microphone=(self), camera=()",
  }
  const reply = (value: unknown, status = 200) => Response.json(value, {
    status, headers,
  })
  const authorized = (request: Request) => {
    const token = request.headers.get("authorization") ?? ""
    const expected = `Bearer ${secret}`
    return Buffer.byteLength(token) === Buffer.byteLength(expected)
      && timingSafeEqual(Buffer.from(token), Buffer.from(expected))
  }
  const server = Bun.serve<SocketData>({
    hostname: "127.0.0.1", port: options.port ?? 0,
    maxRequestBodySize: 128 * 1024,
    idleTimeout: 30,
    async fetch(request, server) {
      const url = new URL(request.url)
      if (request.headers.get("host") !== new URL(origin).host) {
        return reply({ error: "Invalid Host" }, 403)
      }
      const from = request.headers.get("origin")
      if (from && from !== origin) {
        return reply({ error: "Invalid Origin" }, 403)
      }
      if (request.method === "GET"
        && ["/socket", "/lifetime"].includes(url.pathname)) {
        const lifetime = url.pathname === "/lifetime"
        const protocols = request.headers.get("sec-websocket-protocol")
          ?.split(",").map(value => value.trim()) ?? []
        const supplied = protocols[1]?.slice(5) ?? ""
        const valid = protocols.length === 2
          && protocols[0] === (lifetime
            ? "lectic-live-lifetime" : "lectic-live-pcm")
          && protocols[1].startsWith("auth.")
          && Buffer.byteLength(supplied) === secret.length
          && timingSafeEqual(Buffer.from(supplied), Buffer.from(secret))
        if ((!pcm && !lifetime) || from !== origin || !valid) {
          return reply({ error: "Forbidden" }, 403)
        }
        if (ending || (lifetime ? lifetimeReserved
          : audioReserved || (used && !sleeping) || idling)) {
          return reply({ error: "Session already owned" }, 409)
        }
        // Reserve before open. Only the public first protocol is negotiated;
        // the credential never enters a URL, asset, log or response header.
        if (lifetime) lifetimeReserved = true
        else audioReserved = true
        if (server.upgrade(request, {
          data: { kind: lifetime ? "lifetime" : "audio" },
        })) return
        if (lifetime) lifetimeReserved = false
        else audioReserved = false
        return reply({ error: "Upgrade failed" }, 400)
      }
      if (request.method === "GET" && [
        "/", "/app.js", "/style.css", ...(pcm ? ["/worklet.js"] : []),
      ]
        .includes(url.pathname)) {
        const assets = {
          "/": [html, "text/html; charset=utf-8"],
          "/app.js": [pcm ? geminiBrowserScript : browserScript,
            "text/javascript; charset=utf-8"],
          "/worklet.js": [workletScript, "text/javascript; charset=utf-8"],
          "/style.css": [style, "text/css; charset=utf-8"],
        }
        const asset = assets[url.pathname as keyof typeof assets]
        return new Response(asset[0], {
          headers: { ...headers, "Content-Type": asset[1] },
        })
      }
      if (request.method !== "POST" || from !== origin
        || !authorized(request)) return reply({ error: "Forbidden" }, 403)
      if (controls >= 16) return reply({ error: "Too many controls" }, 429)
      controls++
      try {
        const body = record(await request.json())
        heartbeat = Date.now()
        attached = true
        switch (url.pathname) {
          case "/state":
            prune()
            return reply({
              phase, used, ending, ready, confirmed, seconds: usage.seconds,
              sessionId: session?.owner.sessionId ?? parkedSessionId,
              usage: pcm ? { unit: "tokens", latest: latestTokens,
                final: false, connectedSeconds: elapsed(),
                previous: previousTokenReports }
                : usage.snapshot(used),
              lifecycle: lifecycle.snapshot(),
              elapsed: elapsed(), sleeping, idling, idleTimeout,
              busy: coordinator?.busy ?? false,
              backend: coordinator?.status ?? "Idle",
              runs: completedRuns + (coordinator?.runs ?? 0), captions,
              tasks: coordinator?.diagnostics() ?? [],
              diagnostics: journal.snapshot(),
            })
          case "/start": {
            if ((used && !sleeping) || idling || ending) {
              return reply({ error: "Already started" }, 409)
            }
            let sdp = ""
            if (pcm) {
              if (!audioOwner || audioOwner.readyState !== 1
                || Object.keys(body).join() !== "rate"
                || typeof body["rate"] !== "number") {
                return reply({ error: "Invalid PCM startup" }, 400)
              }
              frameSamples(body["rate"])
              rate = body["rate"]
            } else {
              sdp = text(body["sdp"])
              if (!sdp || Buffer.byteLength(sdp) > 64 * 1024) {
                return reply({ error: "Invalid offer" }, 400)
              }
            }
            if (used) {
              if (Math.max(elapsed(),
                (pcm ? 0 : usage.snapshot(true).estimatedBillableSeconds))
                + (pcm ? 0 : 15) >= maxSeconds) {
                journal.add("budget_reached")
                void end()
                return reply({ error: "Session budget exhausted" }, 409)
              }
              if (!pcm) usage.nextSession()
              else {
                previousTokenReports.push({ latest: latestTokens,
                  lifecycle: lifecycle.snapshot() })
                if (previousTokenReports.length > 64) {
                  previousTokenReports.shift()
                }
              }
              journal.add("idle_resumed")
            }
            used = true
            sleeping = false
            confirmed = false
            lost = false
            providerLimit = false
            latestTokens = undefined
            lifecycle = new Lifecycle()
            ready = false
            idlePromise = undefined
            clearOnAttach = false
            cancelOnAttach = false
            seen.clear()
            buffered.splice(0)
            const ownerGeneration = ++generation
            began = Date.now()
            lastSpeech = 0
            phase = "Creating paid session and attaching transport"
            creation = (async () => {
              session = await options.connect(
                sdp,
                event => {
                  if (generation === ownerGeneration) receive(event)
                },
                () => {
                  if (generation === ownerGeneration) disconnected()
                },
                startup.signal, previousSession,
              ).catch(error => {
                // Settle accounting before End's wait on creation resolves.
                if (error instanceof CreationRejected
                  || error instanceof LivePromptFailure) {
                  confirmed = true
                  usage.rejectCreation()
                }
                throw error
              })
              if ((session.media.kind === "pcm") !== pcm) {
                throw new SessionFailure("Unexpected provider media")
              }
              if (session.media.kind === "pcm" && !ending) {
                session.media.attach(output => {
                  if (ending || generation !== ownerGeneration) return
                  sendPCM(audioOwner, output, ready)
                })
              }
              const owner = session
              coordinator = new Coordinator(owner.owner, options.backend,
                owner.complete, {
                  journal, contextSeconds: options.contextSeconds,
                  previousSession,
                  changed: checkpoint,
                })
              if (ending || lost) coordinator.stop()
              for (const event of buffered.splice(0)) receive(event)
              if (clearOnAttach) {
                coordinator.clearContext()
                captions.splice(0)
              } else if (cancelOnAttach) coordinator.cancel()
            })()
            try { await creation } catch (error) {
              phase = error instanceof LivePromptFailure
                ? "Live prompt failed — no new session created"
                : error instanceof CreationRejected
                ? "Startup rejected — no new session created"
                : "Startup failed — do not blindly retry; "
                  + "session finalization may be unconfirmed"
              journal.add("startup_failed")
              const detail = error instanceof SessionFailure
                ? error.message : "Connection or protocol failure"
              console.error(`lectic live: startup_failed: ${detail}`)
              void end()
              return reply({ error: `${phase} (${detail})` }, 502)
            }
            if (ending || lost) {
              return reply({ error: "Startup cancelled" }, 409)
            }
            phase = pcm ? "Gemini setup complete — waiting for browser media"
              : "Sideband attached — waiting for browser media"
            return reply({ ...(session!.media.kind === "webrtc"
              ? { sdp: session!.media.sdp } : { media: "pcm" }),
              sessionId: session!.owner.sessionId, idleTimeout })
          }
          case "/ready": {
            if (!session || ready || ending || idling || sleeping) {
              return reply({ error: "Not awaiting bootstrap" }, 409)
            }
            const events = body["events"]
            if (!Array.isArray(events) || events.length > 128) {
              throw new Error("Invalid bootstrap")
            }
            const decoded = session.bootstrap(events.map(raw => text(raw)))
            for (const event of decoded) receive(event)
            if (ending || lost) {
              return reply({ error: "Startup cancelled" }, 409)
            }
            ready = true
            clearTimeout(audioTimer)
            phase = "Connected — microphone enabled in browser"
            return reply({ ok: true })
          }
          case "/recover":
            // Only an established PCM session can park. Explicit End,
            // startup errors and exhausted budgets cannot be revived.
            if (!pcm || ending) {
              return reply({ error: "Recovery unavailable" }, 409)
            }
            if (sleeping) {
              return body["sessionId"] === parkedSessionId
                ? reply({ idle: true })
                : reply({ error: "Not the parked session" }, 409)
            }
            if (!session || body["sessionId"] !== session.owner.sessionId) {
              return reply({ error: "Not an active session" }, 409)
            }
            if (idling) return reply({ idle: await idlePromise })
            if (!ready) return reply({ error: "Not ready" }, 409)
            return reply({ idle: await sleep() })
          case "/idle":
            if (ending || !session
              || body["sessionId"] !== session.owner.sessionId) {
              return reply({ error: "Not an active session" }, 409)
            }
            if (idling) return reply({ idle: await idlePromise })
            if (!ready) return reply({ error: "Not ready" }, 409)
            if (coordinator?.busy || (lastSpeech
              && Date.now() - lastSpeech < idleTimeout * 1000)) {
              return reply({ idle: false })
            }
            return reply({ idle: await sleep() })
          case "/clear":
            if (creation && !coordinator) clearOnAttach = true
            previousSession = undefined
            coordinator?.clearContext()
            checkpoint(true)
            captions.splice(0)
            return reply({ ok: true })
          case "/cancel":
            if (creation && !coordinator) cancelOnAttach = true
            coordinator?.cancel()
            return reply({ ok: true })
          case "/close":
            await end()
            // Let the keepalive response leave before stopping the listener.
            setTimeout(() => { void stop() }, 0)
            return reply({ ok: true, confirmed })
          case "/end":
            await end()
            return reply({ ok: true, confirmed })
          default: return reply({ error: "Not found" }, 404)
        }
      } catch {
        return reply({ error: "Invalid control request" }, 400)
      } finally { controls-- }
    },
    websocket: {
      maxPayloadLength: 8192,
      backpressureLimit: 192000,
      closeOnBackpressureLimit: true,
      open(socket) {
        if (socket.data.kind === "lifetime") {
          if (ending || lifetimeOwner) { socket.close(1008); return }
          lifetimeOwner = socket
          attached = true
          heartbeat = Date.now()
          return
        }
        if (ending || audioOwner) { socket.close(1008); return }
        audioOwner = socket
        attached = true
        heartbeat = Date.now()
        audioTimer = setTimeout(() => {
          journal.add("startup_timeout")
          void end()
        }, 30000)
      },
      message(socket, data) {
        if (socket.data.kind === "lifetime") {
          // This channel carries presence only, never provider commands.
          socket.close(1008)
          void stop()
          return
        }
        if (ending || socket !== audioOwner) {
          socket.close(1008)
          return
        }
        // Capture already in flight when parking must not turn a safe
        // close into a terminal failure. It is discarded, never replayed.
        if (idling || sleeping) return
        try {
          const now = Date.now()
          if (now - audioWindow >= 1000) {
            audioWindow = now
            audioFrames = 0
          }
          if (++audioFrames > 100 || typeof data === "string"
            || !ready || idling || sleeping || !session
            || session.media.kind !== "pcm"
            || data.byteLength !== frameSamples(rate) * 2) {
            throw new Error("Invalid local audio")
          }
          session.media.capture(data, rate)
        } catch {
          if (!idling) {
            journal.add("invalid_local_audio_or_overload")
            void end()
          }
        }
      },
      close(socket, code) {
        if (socket === lifetimeOwner) {
          // Browser exit can discard pagehide's keepalive fetch entirely.
          // This owner spans idle/recovery and both voice transports.
          journal.add("browser_lost")
          void stop()
          return
        }
        if (socket === audioOwner && !ending) {
          journal.add("browser_lost", undefined, {
            source: "transport", code: "Local WebSocket closed",
            closeCode: code,
          })
          // Bun reports oversized frames as 1006 too. Do not treat an
          // ambiguous local protocol failure as permission to reconnect.
          if (ready && !idling && (code === 1000 || code === 1001)) {
            void sleep()
          } else if (!idling) void end()
        }
      },
    },
    error() { return reply({ error: "Local controller error" }, 500) },
  })
  origin = `http://127.0.0.1:${server.port}`
  const watchdog = setInterval(() => {
    prune()
    if (attached && Date.now() - heartbeat
      > (options.heartbeatMs ?? 10_000)) {
      journal.add("browser_lost")
      void stop()
      return
    }
    if (!used || ending) return
    if (began && !pcm) usage.update((Date.now() - began) / 1000)
    const reason = Math.max(elapsed(),
        pcm ? 0 : usage.snapshot(true).estimatedBillableSeconds)
          >= maxSeconds
        ? "budget_reached" : began && !ready && !idling
          && Date.now() - began > 35_000
          ? "startup_timeout" : undefined
    if (reason) { journal.add(reason); void end() }
  }, options.watchdogMs ?? 500)
  function stop(): Promise<void> {
    if (stopPromise) return stopPromise
    clearInterval(watchdog)
    stopPromise = (async () => {
      try { await end() } finally {
        audioOwner?.terminate()
        const lifetime = lifetimeOwner
        lifetimeOwner = undefined
        lifetime?.terminate()
        try {
          if (pcm || audioReserved || lifetimeReserved) {
            // Bun 1.3 may retain pendingWebSockets after close. Stop
            // synchronously and bound its wait after explicit owner cleanup.
            await Promise.race([server.stop(true), Bun.sleep(100)])
          } else await server.stop(true)
        } finally { resolveStopped() }
      }
    })()
    return stopPromise
  }
  return {
    url: `${origin}/#${secret}`, origin, secret, stopped, stop,
  }
}
