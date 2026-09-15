import { createHash, randomBytes, timingSafeEqual } from "node:crypto"
import { Coordinator, type Backend } from "./coordinator"
import { decodeEvent, record, text, type LiveEvent } from "./protocol"
import {
  CreationRejected, SessionFailure, type Connect, type SessionConnection,
} from "./session"
import { html, browserScript, style } from "./web"
import { Journal, Usage } from "./state"
import { mergeHistory, type History, type HistoryContext } from "./history"

export type ServerOptions = {
  port?: number
  connect: Connect
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
  let sleeping = false
  let idling = false
  let generation = 0
  let idlePromise: Promise<boolean> | undefined
  let completedRuns = 0
  let completedElapsed = 0
  let lastSpeech = 0
  let session: SessionConnection | undefined
  let coordinator: Coordinator | undefined
  let creation: Promise<void> | undefined
  let endPromise: Promise<void> | undefined
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
  const buffered: LiveEvent[] = []
  const seen = new Set<string>()
  const maxSeconds = options.maxSessionSeconds ?? 600
  let origin = ""
  let controls = 0
  let clearOnAttach = false
  let cancelOnAttach = false

  function prune() {
    while (captions.length
      && captions[0].received < Date.now() - contextMs) captions.shift()
    coordinator?.diagnostics()
    checkpoint()
  }

  function receive(event: LiveEvent) {
    if (!session) {
      if (buffered.length >= 256) throw new Error("Bootstrap overflow")
      buffered.push(event)
      return
    }
    if (event.type === "session.started"
      || event.type === "session.closed") {
      if (event.session.id !== session.id) {
        throw new Error("Wrong session ownership")
      }
    }
    // Deduplicate bootstrap copies and sideband events. Never use browser
    // captions as a second execution path after the bounded handoff.
    const key = "event_id" in event && event.event_id
      ? `id:${event.event_id}`
      : createHash("sha256").update(JSON.stringify(event)).digest("hex")
    if (seen.has(key)) return
    if (seen.size >= 8192) {
      journal.add("event_limit")
      void end()
      return
    }
    seen.add(key)
    // The archive is opt-in and contains transcript text, not raw audio,
    // SDP, API keys, or reflected transport payloads.
    if (event.type !== "error") options.history?.append("event", event)
    if (!ending && (event.type === "session.input_transcript.delta"
      || event.type === "session.output_transcript.delta")) {
      lastSpeech = Date.now()
      captions.push({
        sequence: ++sequence,
        speaker: event.type === "session.input_transcript.delta"
          ? "You" : "GPT-Live",
        text: event.delta, received: Date.now(),
      })
      while (captions.length > 96
        || Buffer.byteLength(JSON.stringify(captions)) > 20_000) {
        captions.shift()
      }
    } else if (event.type === "session.usage.updated"
      || event.type === "session.closed") {
      usage.update(event.usage.seconds, event.type === "session.closed")
      if (usage.snapshot(used).estimatedBillableSeconds >= maxSeconds
        && !ending) {
        journal.add("budget_reached")
        void end()
      }
      if (event.type === "session.closed") {
        confirmed = true
        if (!idling) void end()
      }
    } else if (event.type === "error") {
      journal.add("live_error")
      phase = "Live reported an error; ending session"
      void end()
    }
    // Drain final transcripts, but never launch work during an idle close.
    if (!ending && !lost && (!idling
      || event.type === "session.input_transcript.delta"
      || event.type === "session.output_transcript.delta")) {
      coordinator?.receive(event)
    }
  }

  function disconnected() {
    if (lost || confirmed || idling || sleeping) return
    lost = true
    journal.add("sideband_lost")
    phase = "Sideband lost — no new work; ending session"
    coordinator?.stop()
    void end()
  }

  function elapsed() {
    return completedElapsed + (began ? (Date.now() - began) / 1000 : 0)
  }

  async function sleep() {
    if (idlePromise) return idlePromise
    idling = true
    ready = false
    phase = "Disconnecting idle session"
    idlePromise = (async () => {
      try {
        confirmed = await session!.close() || confirmed
        if (!confirmed || ending) {
          if (!confirmed) journal.add("finalization_uncertain")
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
        coordinator = undefined
        session = undefined
        creation = undefined
        sleeping = true
        journal.add("idle_disconnected")
        phase = "Idle — disconnected; microphone wake detection is local"
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
    startup.abort()
    coordinator?.stop()
    endPromise = (async () => {
      await creation?.catch(() => {})
      coordinator?.stop()
      try {
        if (session) confirmed = await session.close() || confirmed
      } catch { journal.add("finalization_uncertain") }
      await coordinator?.idle()
      completedElapsed = elapsed()
      began = 0
      journal.add(confirmed || !used ? "ended" : "finalization_uncertain")
      phase = confirmed ? "Ended — final usage confirmed"
        : used ? "Ended — session finalization/usage unconfirmed"
          : "Ended — no session created"
    })()
    return endPromise
  }

  const headers = {
    "Content-Security-Policy": "default-src 'none'; script-src 'self'; "
      + "style-src 'self'; connect-src 'self'; media-src 'self' blob:; "
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
  const server = Bun.serve({
    hostname: "127.0.0.1", port: options.port ?? 0,
    maxRequestBodySize: 128 * 1024,
    idleTimeout: 30,
    async fetch(request) {
      const url = new URL(request.url)
      if (request.headers.get("host") !== new URL(origin).host) {
        return reply({ error: "Invalid Host" }, 403)
      }
      const from = request.headers.get("origin")
      if (from && from !== origin) {
        return reply({ error: "Invalid Origin" }, 403)
      }
      if (request.method === "GET" && ["/", "/app.js", "/style.css"]
        .includes(url.pathname)) {
        const assets = {
          "/": [html, "text/html; charset=utf-8"],
          "/app.js": [browserScript, "text/javascript; charset=utf-8"],
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
        switch (url.pathname) {
          case "/state":
            prune()
            return reply({
              phase, used, ending, ready, confirmed, seconds: usage.seconds,
              usage: usage.snapshot(used),
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
            const sdp = text(body["sdp"])
            if (!sdp || Buffer.byteLength(sdp) > 64 * 1024) {
              return reply({ error: "Invalid offer" }, 400)
            }
            if (used) {
              if (Math.max(elapsed(),
                usage.snapshot(true).estimatedBillableSeconds)
                + 15 > maxSeconds) {
                journal.add("budget_reached")
                void end()
                return reply({ error: "Session budget exhausted" }, 409)
              }
              usage.nextSession()
              journal.add("idle_resumed")
            }
            used = true
            sleeping = false
            confirmed = false
            ready = false
            idlePromise = undefined
            clearOnAttach = false
            cancelOnAttach = false
            seen.clear()
            buffered.splice(0)
            const ownerGeneration = ++generation
            began = Date.now()
            lastSpeech = 0
            phase = "Creating paid session and attaching sideband"
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
                if (error instanceof CreationRejected) {
                  confirmed = true
                  usage.rejectCreation()
                }
                throw error
              })
              const owner = session
              coordinator = new Coordinator(owner.id, options.backend,
                (id, content) => owner.client.append(
                  "commentary", id, content,
                ), {
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
              phase = error instanceof CreationRejected
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
            phase = "Sideband attached — waiting for browser media"
            return reply({ sdp: session!.sdp,
              sessionId: session!.id, idleTimeout })
          }
          case "/ready": {
            if (!session || ready || ending || idling || sleeping) {
              return reply({ error: "Not awaiting bootstrap" }, 409)
            }
            const events = body["events"]
            if (!Array.isArray(events) || events.length > 128) {
              throw new Error("Invalid bootstrap")
            }
            const decoded = events.map(raw => decodeEvent(text(raw)))
            if (!decoded.some(e => e?.type === "session.started"
              && e.session.id === session!.id)) {
              throw new Error("Missing session.started")
            }
            for (const event of decoded) if (event) receive(event)
            if (ending || lost) {
              return reply({ error: "Startup cancelled" }, 409)
            }
            ready = true
            phase = "Connected — microphone enabled in browser"
            return reply({ ok: true })
          }
          case "/idle":
            if (ending || !session || body["sessionId"] !== session.id) {
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
          case "/end":
            await end()
            return reply({ ok: true, confirmed })
          default: return reply({ error: "Not found" }, 404)
        }
      } catch {
        return reply({ error: "Invalid control request" }, 400)
      } finally { controls-- }
    },
    error() { return reply({ error: "Local controller error" }, 500) },
  })
  origin = `http://127.0.0.1:${server.port}`
  const watchdog = setInterval(() => {
    prune()
    if (!used || ending) return
    if (began) usage.update((Date.now() - began) / 1000)
    const reason = Date.now() - heartbeat > (options.heartbeatMs ?? 10_000)
      ? "browser_lost" : Math.max(elapsed(),
        usage.snapshot(true).estimatedBillableSeconds) >= maxSeconds
        ? "budget_reached" : began && !ready && !idling
          && Date.now() - began > 35_000
          ? "startup_timeout" : undefined
    if (reason) { journal.add(reason); void end() }
  }, options.watchdogMs ?? 500)
  return {
    url: `${origin}/#${secret}`, origin, secret,
    async stop() {
      clearInterval(watchdog)
      try { await end() } finally { await server.stop(true) }
    },
  }
}
