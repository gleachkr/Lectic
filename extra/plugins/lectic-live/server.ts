import { createHash, randomBytes, timingSafeEqual } from "node:crypto"
import { Coordinator, type Backend } from "./coordinator"
import { decodeEvent, record, text, type LiveEvent } from "./protocol"
import { SessionFailure, type Connect, type SessionConnection }
  from "./session"
import { html, browserScript, style } from "./web"
import { Journal, Usage } from "./state"
import type { History, HistoryContext } from "./history"

export type ServerOptions = {
  port?: number
  connect: Connect
  backend: Backend
  maxSessionSeconds?: number
  contextSeconds?: number
  heartbeatMs?: number
  watchdogMs?: number
  history?: History
  previousSession?: HistoryContext
}

export function startServer(options: ServerOptions) {
  const secret = randomBytes(32).toString("hex")
  const startup = new AbortController()
  let phase = "Ready — no paid session started"
  let used = false
  let ending = false
  let confirmed = false
  let ready = false
  let lost = false
  let session: SessionConnection | undefined
  let coordinator: Coordinator | undefined
  let creation: Promise<void> | undefined
  let endPromise: Promise<void> | undefined
  let heartbeat = Date.now()
  let began = 0
  const usage = new Usage()
  let previousSession = options.previousSession
  const journal = new Journal(options.previousSession?.conversationId, () => {
    const event = journal.snapshot().at(-1)
    options.history?.append("lifecycle", event)
    checkpoint(event?.code === "context_cleared")
  })

  function checkpoint(reset = false) {
    if (!options.history) return
    options.history.checkpoint(coordinator?.historyContext()
      ?? previousSession ?? {
        version: 1, conversationId: journal.conversationId,
        incomplete: false, fragments: [], tasks: [],
      }, reset)
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
      if (usage.seconds >= maxSeconds && !ending) {
        journal.add("budget_reached")
        void end()
      }
      if (event.type === "session.closed") {
        confirmed = true
        void end()
      }
    } else if (event.type === "error") {
      journal.add("live_error")
      phase = "Live reported an error; ending session"
      void end()
    }
    if (!ending && !lost) coordinator?.receive(event)
  }

  function disconnected() {
    if (lost || confirmed) return
    lost = true
    journal.add("sideband_lost")
    phase = "Sideband lost — no new work; ending session"
    coordinator?.stop()
    void end()
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
              elapsed: began ? (Date.now() - began) / 1000 : 0,
              backend: coordinator?.status ?? "Idle",
              runs: coordinator?.runs ?? 0, captions,
              tasks: coordinator?.diagnostics() ?? [],
              diagnostics: journal.snapshot(),
            })
          case "/start": {
            if (used || ending) {
              return reply({ error: "Already started" }, 409)
            }
            const sdp = text(body["sdp"])
            if (!sdp || Buffer.byteLength(sdp) > 64 * 1024) {
              return reply({ error: "Invalid offer" }, 400)
            }
            used = true
            began = Date.now()
            phase = "Creating paid session and attaching sideband"
            creation = (async () => {
              session = await options.connect(
                sdp, receive, disconnected, startup.signal,
              )
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
              phase = "Startup failed — do not blindly retry; "
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
            return reply({ sdp: session!.sdp })
          }
          case "/ready": {
            if (!session || ready || ending) {
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
            ready = true
            phase = "Connected — microphone enabled in browser"
            return reply({ ok: true })
          }
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
    const reason = Date.now() - heartbeat > (options.heartbeatMs ?? 10_000)
      ? "browser_lost" : Date.now() - began > maxSeconds * 1000
        ? "budget_reached" : !ready && Date.now() - began > 35_000
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
