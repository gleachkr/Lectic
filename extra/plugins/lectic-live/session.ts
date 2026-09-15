import {
  createRequest, decodeCreated, record, type LiveEvent,
} from "./protocol"
import { LiveClient } from "./live-client"

export class SessionFailure extends Error {}

export interface SessionConnection {
  id: string
  sdp: string
  client: LiveClient
  close(): Promise<boolean>
}
export type Connect = (
  sdp: string,
  receive: (event: LiveEvent) => void,
  lost: () => void,
  signal: AbortSignal,
) => Promise<SessionConnection>

type SocketFactory = (
  url: string, options: Bun.WebSocketOptions,
) => WebSocket

const defaultSocket: SocketFactory = (url, options) => {
  // lib.dom hides Bun's constructor overload when browser types are loaded.
  const Socket = WebSocket as unknown as {
    new(url: string, options: Bun.WebSocketOptions): WebSocket
  }
  return new Socket(url, options)
}

// Provider bodies and socket reasons can echo prompts, credentials or proxy
// headers. Only classify known machine codes; never log body excerpts.
export function describeFailure(body: string): string {
  const known = new Set([
    "model_not_found", "invalid_api_key", "insufficient_quota",
    "rate_limit_exceeded", "permission_denied", "invalid_request_error",
  ])
  try {
    const error = record(record(JSON.parse(body))["error"])
    const code = error["code"] ?? error["type"]
    if (typeof code === "string" && known.has(code)) return `: ${code}`
  } catch { /* Unknown bodies are intentionally not diagnostic content. */ }
  return ""
}

async function boundedBody(response: Response) {
  const reader = response.body?.getReader()
  if (!reader) return ""
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > 256 * 1024) {
        throw new SessionFailure("Oversized response; finalization uncertain")
      }
      chunks.push(value)
    }
    return Buffer.concat(chunks).toString("utf8")
  } finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

// No retries: creation can incur a charge even when its response is lost.
export function liveConnector(
  key: string, voice?: string,
  io: { fetch: typeof fetch; socket: SocketFactory } = {
    fetch: globalThis.fetch, socket: defaultSocket,
  },
): Connect {
  return async (sdp, receive, lost, signal) => {
    const endpoint = "https://api.openai.com/v1/live/sessions"
    const response = await io.fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`, "Content-Type": "application/json",
      },
      body: JSON.stringify(createRequest(sdp, voice)),
      signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]),
    })
    const body = await boundedBody(response)
    if (!response.ok) {
      throw new SessionFailure(
        `Live creation failed (HTTP ${response.status})`
        + describeFailure(body),
      )
    }
    const created = decodeCreated(JSON.parse(body))
    let closed = false
    let releasing = false
    let lossReported = false
    let closePromise: Promise<boolean> | undefined
    const reportLoss = () => {
      if (closed || releasing || lossReported) return
      lossReported = true
      lost()
    }
    let finishClose: (() => void) | undefined
    const socket = io.socket(
      "wss://api.openai.com/v1/live/sessions/"
        + `${encodeURIComponent(created.sessionId)}/attach`,
      { headers: { Authorization: `Bearer ${key}` } },
    )
    const client = new LiveClient({ send: raw => socket.send(raw) })
    socket.addEventListener("message", event => {
      try {
        if (typeof event.data !== "string") return
        const decoded = client.receive(event.data)
        if (!decoded) return
        if ((decoded.type === "session.started"
          || decoded.type === "session.closed")
          && decoded.session.id !== created.sessionId) {
          throw new Error("Wrong session ownership")
        }
        if (decoded.type === "session.closed"
          && decoded.session.id === created.sessionId) {
          closed = true
          finishClose?.()
        }
        receive(decoded)
      } catch {
        client.disconnect()
        reportLoss()
        socket.close()
      }
    })
    socket.addEventListener("close", () => {
      client.disconnect()
      finishClose?.()
      reportLoss()
    })
    try {
      await new Promise<void>((resolve, reject) => {
        let settled = false
        const timeout = setTimeout(() => done(false, "timed out"), 10_000)
        const abort = () => done(false, "aborted")
        const done = (ok: boolean, why?: string) => {
          if (settled) return
          settled = true
          clearTimeout(timeout)
          signal.removeEventListener("abort", abort)
          if (ok) resolve()
          else reject(new SessionFailure("Sideband attachment failed"
            + (why ? ` (${why})` : "")
            + "; session finalization uncertain"))
        }
        socket.addEventListener("open", () => done(true), { once: true })
        // A failed handshake fires error then close; close carries the code.
        socket.addEventListener("close", event => done(false,
          `closed ${event.code}`,
        ), { once: true })
        signal.addEventListener("abort", abort, { once: true })
        if (signal.aborted) abort()
      })
    } catch (error) {
      socket.close()
      throw error
    }
    return {
      id: created.sessionId, sdp: created.sdp, client,
      close() {
        // A synchronous terminal event or two End callers cannot send twice.
        closePromise ??= Promise.resolve().then(async () => {
          try {
            if (!closed && socket.readyState === WebSocket.OPEN) {
              await new Promise<void>(resolve => {
                const timer = setTimeout(resolve, 3000)
                finishClose = () => { clearTimeout(timer); resolve() }
                try {
                  socket.send(JSON.stringify({ type: "session.close" }))
                } catch { finishClose() }
              })
            }
          } finally {
            releasing = true
            finishClose = undefined
            client.disconnect()
            socket.close()
          }
          return closed
        })
        return closePromise
      },
    }
  }
}
