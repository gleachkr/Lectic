import { randomBytes, timingSafeEqual } from "node:crypto"
import type { ServerWebSocket } from "bun"
import { frameSamples } from "../gemini-audio"
import { page, style } from "./page"
import { SpikeSession, type SpikeOptions } from "./session"
import { object } from "./wire"

export type ProviderSocket = {
  readyState: number
  bufferedAmount: number
  send: (data: string) => void
  close: () => void
  onopen: (() => void) | null
  onmessage: ((event: { data: unknown }) => void) | null
  onerror: (() => void) | null
  onclose: (() => void) | null
}
export type HarnessOptions = {
  assets: { browser: string; worklet: string }
  connect: () => ProviderSocket
  real?: SpikeOptions["real"]
  history?: boolean
  fakeDelayMs?: number
  heartbeatMs?: number
  maxSessionMs?: number
}

export function startHarness(options: HarnessOptions) {
  const secret = randomBytes(32).toString("hex")
  let owner: ServerWebSocket<undefined> | undefined
  let reserved = false
  let provider: ProviderSocket | undefined
  let session: SpikeSession | undefined
  let ended = false
  let origin = ""
  let began = 0
  let heartbeat = Date.now()
  let messages = 0
  let windowStart = Date.now()
  let controls = 0
  let startup: ReturnType<typeof setTimeout> | undefined

  const headers = {
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'none'; script-src 'self'; "
      + "style-src 'self'; connect-src 'self'; worker-src 'self'; "
      + "frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  }
  function close() {
    if (ended) return
    ended = true
    clearTimeout(startup)
    try { provider?.close() } catch { /* No raw transport diagnostics. */ }
    owner?.close(1000)
    // Bound the local close handshake too; never retain a stalled owner.
    setTimeout(() => {
      if (owner && owner.readyState !== 3) owner.terminate()
    }, 250).unref()
  }
  function end(code: string) {
    if (ended) return
    session?.stop(code)
    close()
  }
  function sendBrowser(data: string | Uint8Array) {
    if (!owner || owner.readyState !== 1
      || owner.getBufferedAmount() > 192000) {
      throw new Error("Browser overload or loss")
    }
    if (owner.send(data) === 0) throw new Error("Browser send failed")
  }
  const server = Bun.serve<undefined>({
    hostname: "127.0.0.1", port: 0,
    fetch(request, server) {
      const url = new URL(request.url)
      const reply = (body: string, status = 200, mime = "text/plain") =>
        new Response(body, { status, headers: {
          ...headers, "Content-Type": mime,
        } })
      if (request.headers.get("host") !== new URL(origin).host
        || (request.headers.has("origin")
          && request.headers.get("origin") !== origin)) {
        return reply("Forbidden", 403)
      }
      if (request.method !== "GET") return reply("Method not allowed", 405)
      if (url.pathname === "/socket") {
        const protocols = request.headers.get("sec-websocket-protocol")
          ?.split(",").map(value => value.trim()) ?? []
        const supplied = protocols.find(p => p.startsWith("auth."))
          ?.slice(5) ?? ""
        const valid = Buffer.byteLength(supplied) === secret.length
          && timingSafeEqual(Buffer.from(supplied), Buffer.from(secret))
        if (request.headers.get("origin") !== origin || !valid
          || protocols[0] !== "lectic-gemini-spike") {
          return reply("Forbidden", 403)
        }
        if (reserved || ended) return reply("Session already owned", 409)
        // Reserve before upgrade, including the interval before open.
        reserved = true
        // Bun negotiates the first offered protocol automatically. Explicit
        // response headers duplicate it in Bun 1.3, breaking the handshake.
        // Require the public protocol first, never reflect the auth token.
        if (server.upgrade(request)) return
        reserved = false
        return reply("Upgrade failed", 400)
      }
      switch (url.pathname) {
        case "/": return reply(page.replace("{{mode}}", options.real
          ? "REAL mode: one approved Lectic run, with configured permissions."
          : "FAKE mode: no Lectic process or real actions."),
        200, "text/html; charset=utf-8")
        case "/style.css": return reply(style, 200, "text/css")
        case "/browser.js":
          return reply(options.assets.browser, 200, "text/javascript")
        case "/worklet.js":
          return reply(options.assets.worklet, 200, "text/javascript")
        default: return reply("Not found", 404)
      }
    },
    websocket: {
      maxPayloadLength: 8192,
      backpressureLimit: 192000,
      closeOnBackpressureLimit: true,
      open(socket) {
        owner = socket
        heartbeat = Date.now()
        startup = setTimeout(() => end("startup_timeout"), 15000)
      },
      message(socket, data) {
        if (ended || socket !== owner) return
        try {
          const now = Date.now()
          if (now - windowStart >= 1000) {
            messages = 0
            controls = 0
            windowStart = now
          }
          if (++messages > 100) throw new Error("Local message rate limit")
          if (typeof data !== "string") {
            if (!session) throw new Error("Audio before startup")
            session.capture(data)
            return
          }
          if (++controls > 10 || Buffer.byteLength(data) > 1024) {
            throw new Error("Control limit")
          }
          const control = object(JSON.parse(data))
          switch (control["type"]) {
            case "start": {
              if (session
                || Object.keys(control).sort().join() !== "rate,type"
                || typeof control["rate"] !== "number") {
                throw new Error("Invalid start")
              }
              frameSamples(control["rate"])
              const rate = control["rate"]
              began = Date.now()
              session = new SpikeSession({
                real: options.real, history: options.history,
                fakeDelayMs: options.fakeDelayMs, sendBrowser, close,
                sendProvider(wire) {
                  if (!provider || provider.readyState !== 1
                    || provider.bufferedAmount > 256000) {
                    throw new Error("Provider overload or loss")
                  }
                  provider.send(wire)
                },
              })
              provider = options.connect()
              provider.onopen = () => {
                if (ended) { provider?.close(); return }
                clearTimeout(startup)
                try { session!.open(rate) } catch { end("setup_send_failed") }
              }
              provider.onmessage = event => {
                if (ended) return
                try {
                  const data = event.data
                  if (typeof data === "string") session!.receive(data)
                  else if (data instanceof ArrayBuffer
                    || data instanceof Uint8Array) {
                    if (data.byteLength > 512 * 1024) {
                      throw new Error("Provider frame limit")
                    }
                    session!.receive(new TextDecoder("utf-8", {
                      fatal: true,
                    }).decode(data))
                  } else throw new Error("Unexpected provider frame")
                } catch { end("unexpected_provider_frame") }
              }
              provider.onerror = () => end("provider_transport_error")
              provider.onclose = () => end("provider_closed_usage_unknown")
              break
            }
            case "ping":
              if (Object.keys(control).length !== 1) {
                throw new Error("Invalid heartbeat")
              }
              heartbeat = now
              break
            case "approve":
              if (!session || !Number.isSafeInteger(control["call"])
                || Object.keys(control).sort().join() !== "call,type") {
                throw new Error("Invalid approval")
              }
              session.approve(control["call"] as number)
              break
            default: throw new Error("Unknown browser control")
          }
        } catch { end("invalid_local_frame_or_transport_failure") }
      },
      close(socket) {
        if (socket === owner) end("browser_closed")
      },
    },
    error() {
      return new Response("Local controller failure", { status: 500 })
    },
  })
  origin = `http://127.0.0.1:${server.port}`
  const watchdog = setInterval(() => {
    if (!reserved || ended) return
    if (Date.now() - heartbeat > (options.heartbeatMs ?? 10000)) {
      end("browser_heartbeat_lost")
    } else if (began && Date.now() - began
      > (options.maxSessionMs ?? 300000)) end("connected_time_limit")
  }, 250)
  return {
    origin, secret, url: `${origin}/#${secret}`,
    async stop() {
      clearInterval(watchdog)
      end("controller_stopped")
      await session?.idle()
      owner?.terminate()
      // Bun 1.3 can leave pendingWebSockets nonzero after close, so its
      // stop promise never settles. Listening stops synchronously; the
      // owner is explicitly terminated and backend cleanup awaited above.
      await Promise.race([server.stop(true), Bun.sleep(100)])
    },
  }
}
