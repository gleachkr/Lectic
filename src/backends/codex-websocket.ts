const RESPONSES_WEBSOCKET_BETA = "responses_websockets=2026-02-06"
const DEFAULT_CONNECT_TIMEOUT_MS = 15_000
const DEFAULT_IDLE_TIMEOUT_MS = 5 * 60 * 1000
const DEFAULT_MAX_CONNECTION_AGE_MS = 55 * 60 * 1000
const CONNECTION_LIMIT_REACHED_CODE = "websocket_connection_limit_reached"

export type CodexWebSocketFetch = {
  (input: RequestInfo | URL, init?: RequestInit): Promise<Response>
  close(): void
  remove(sessionId: string): void
}

type WebSocketCtor = new (
  url: string,
  options?: { headers?: Record<string, string> }
) => WebSocket

type PoolEntry = {
  socket?: WebSocket
  connectedAt?: number
  lastUsedAt: number
  busy: boolean
  fallback: boolean
  streamFailures: number
}

type ParsedBody = Record<string, unknown> & {
  prompt_cache_key?: unknown
  stream?: unknown
}

type FirstEvent =
  | { kind: "ok" }
  | { kind: "invalid" }
  | { kind: "error"; error: WrappedError }

type WrappedError = {
  status: number
  headers?: Record<string, string>
  body: string
}

export type CodexWebSocketFetchOptions = {
  httpFetch?: typeof fetch
  connectTimeoutMs?: number
  idleTimeoutMs?: number
  maxConnectionAgeMs?: number
  streamRetries?: number
  WebSocketImpl?: WebSocketCtor
}

export function createCodexWebSocketFetch(
  options: CodexWebSocketFetchOptions = {}
): CodexWebSocketFetch {
  const httpFetch = options.httpFetch ?? fetch
  const pool = new Map<string, PoolEntry>()
  const connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS
  const idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS
  const maxConnectionAgeMs = options.maxConnectionAgeMs ?? DEFAULT_MAX_CONNECTION_AGE_MS
  const streamRetries = options.streamRetries ?? 5
  const WebSocketImpl = options.WebSocketImpl ?? (globalThis.WebSocket as WebSocketCtor)

  const pruneTimer = setInterval(() => prune(), Math.min(idleTimeoutMs, 60_000))
  if (typeof pruneTimer === "object" && "unref" in pruneTimer) {
    const unref = pruneTimer.unref
    if (typeof unref === "function") unref.call(pruneTimer)
  }

  async function codexWebSocketFetch(
    input: RequestInfo | URL,
    init?: RequestInit
  ): Promise<Response> {
    const url = requestUrl(input)
    const parsedUrl = new URL(url)
    if (init?.method !== "POST" || !parsedUrl.pathname.endsWith("/responses")) {
      return httpFetch(input, init)
    }

    const bodyText = requestBodyText(init.body)
    const body = bodyText ? parseRequestBody(bodyText) : undefined
    if (!body || body.stream !== true) return httpFetch(input, init)

    const headers = new Headers(init.headers)
    const sessionId = sessionIdFor(headers, body)
    if (sessionId) {
      if (!headers.has("session-id")) headers.set("session-id", sessionId)
      if (!headers.has("thread-id")) headers.set("thread-id", sessionId)
    }

    const httpInit = { ...init, headers }
    const key = `${sessionId ?? "default"}:responses`
    const entry = pool.get(key) ?? {
      lastUsedAt: Date.now(),
      busy: false,
      fallback: false,
      streamFailures: 0,
    }
    pool.set(key, entry)

    if (entry.fallback || entry.busy) {
      return httpFetch(input, httpInit)
    }

    entry.busy = true
    entry.lastUsedAt = Date.now()

    try {
      const socket = await getSocket({
        entry,
        url,
        headers,
        connectTimeoutMs,
        maxConnectionAgeMs,
        signal: init.signal ?? undefined,
        WebSocketImpl,
      })

      const { response, firstEvent } = streamResponsesWebSocket({
        socket,
        body,
        idleTimeoutMs,
        signal: init.signal ?? undefined,
        onTerminal: (event) => {
          entry.busy = false
          entry.lastUsedAt = Date.now()
          entry.streamFailures = 0
          if (!isSuccessfulTerminal(event)) invalidate(entry)
        },
        onConnectionInvalid: () => {
          entry.busy = false
          entry.lastUsedAt = Date.now()
          recordStreamFailure(entry, streamRetries)
          invalidate(entry)
        },
        onAbort: () => {
          entry.busy = false
          entry.lastUsedAt = Date.now()
          entry.streamFailures = 0
          invalidate(entry)
        },
      })

      const first = await firstEvent
      if (first.kind === "ok") return response

      if (first.kind === "error") {
        entry.busy = false
        entry.lastUsedAt = Date.now()
        if (!entry.fallback) recordStreamFailure(entry, streamRetries)
        return new Response(first.error.body, {
          status: first.error.status,
          headers: {
            "content-type": "application/json",
            ...(first.error.headers ?? {}),
          },
        })
      }

      if (entry.fallback) return await httpFetch(input, httpInit)
      return response
    } catch {
      entry.busy = false
      entry.lastUsedAt = Date.now()
      recordStreamFailure(entry, streamRetries)
      invalidate(entry)
      return httpFetch(input, httpInit)
    }
  }

  function recordStreamFailure(entry: PoolEntry, retryLimit: number) {
    entry.streamFailures++
    if (entry.streamFailures > retryLimit) entry.fallback = true
  }

  function prune() {
    const now = Date.now()
    for (const [key, entry] of pool) {
      if (entry.busy || entry.fallback) continue
      if (now - entry.lastUsedAt < idleTimeoutMs) continue
      invalidate(entry)
      pool.delete(key)
    }
  }

  function close() {
    clearInterval(pruneTimer)
    for (const entry of pool.values()) invalidate(entry)
    pool.clear()
  }

  function remove(sessionId: string) {
    const entry = pool.get(`${sessionId}:responses`)
    if (!entry) return
    invalidate(entry)
    pool.delete(`${sessionId}:responses`)
  }

  return Object.assign(codexWebSocketFetch, { close, remove })
}

function requestUrl(input: RequestInfo | URL): string {
  if (input instanceof URL) return input.toString()
  return typeof input === "string" ? input : input.url
}

function requestBodyText(body: BodyInit | null | undefined): string | undefined {
  if (typeof body === "string") return body
  if (body instanceof URLSearchParams) return body.toString()
  if (body instanceof ArrayBuffer) return new TextDecoder().decode(body)
  if (ArrayBuffer.isView(body)) return new TextDecoder().decode(body)
  return undefined
}

function parseRequestBody(body: string): ParsedBody | undefined {
  try {
    const parsed = JSON.parse(body) as unknown
    return isRecord(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

function sessionIdFor(headers: Headers, body: ParsedBody): string | undefined {
  const headerSession = headers.get("session-id") ?? headers.get("x-session-affinity")
  if (headerSession) return headerSession
  return typeof body.prompt_cache_key === "string" ? body.prompt_cache_key : undefined
}

type GetSocketOptions = {
  entry: PoolEntry
  url: string
  headers: Headers
  connectTimeoutMs: number
  maxConnectionAgeMs: number
  signal?: AbortSignal
  WebSocketImpl: WebSocketCtor
}

async function getSocket(options: GetSocketOptions): Promise<WebSocket> {
  const { entry, maxConnectionAgeMs } = options
  if (
    entry.socket?.readyState === WebSocket.OPEN &&
    entry.connectedAt &&
    Date.now() - entry.connectedAt < maxConnectionAgeMs
  ) {
    return entry.socket
  }

  invalidate(entry)
  const socket = await connectResponsesWebSocket(options)
  entry.socket = socket
  entry.connectedAt = Date.now()
  return socket
}

function connectResponsesWebSocket(options: GetSocketOptions): Promise<WebSocket> {
  const { url, headers, connectTimeoutMs, signal, WebSocketImpl } = options
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError(signal))
      return
    }

    const wsHeaders = headersToRecord(headers)
    wsHeaders["openai-beta"] = RESPONSES_WEBSOCKET_BETA
    delete wsHeaders["content-length"]

    const socket = new WebSocketImpl(toWebSocketUrl(url), { headers: wsHeaders })
    const timeout = setTimeout(() => {
      cleanup()
      terminate(socket)
      reject(new Error("WebSocket connect timed out"))
    }, connectTimeoutMs)

    function cleanup() {
      clearTimeout(timeout)
      socket.removeEventListener("open", onOpen)
      socket.removeEventListener("error", onError)
      socket.removeEventListener("close", onClose)
      signal?.removeEventListener("abort", onAbort)
    }

    function onOpen() {
      cleanup()
      resolve(socket)
    }

    function onError(event: Event) {
      cleanup()
      reject(new Error("WebSocket connection error", { cause: event }))
    }

    function onClose(event: CloseEvent) {
      cleanup()
      reject(new Error(closeMessage("WebSocket closed before open", event)))
    }

    function onAbort() {
      cleanup()
      terminate(socket)
      reject(abortError(signal))
    }

    socket.addEventListener("open", onOpen, { once: true })
    socket.addEventListener("error", onError, { once: true })
    socket.addEventListener("close", onClose, { once: true })
    signal?.addEventListener("abort", onAbort, { once: true })
  })
}

function toWebSocketUrl(url: string): string {
  return url.replace(/^http:/, "ws:").replace(/^https:/, "wss:")
}

function headersToRecord(headers: Headers): Record<string, string> {
  const result: Record<string, string> = {}
  headers.forEach((value, key) => {
    result[key.toLowerCase()] = value
  })
  return result
}

type StreamWebSocketOptions = {
  socket: WebSocket
  body: ParsedBody
  idleTimeoutMs: number
  signal?: AbortSignal
  onTerminal: (event: Record<string, unknown>) => void
  onConnectionInvalid: () => void
  onAbort: () => void
}

function streamResponsesWebSocket(options: StreamWebSocketOptions): {
  response: Response
  firstEvent: Promise<FirstEvent>
} {
  const encoder = new TextEncoder()
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined
  let completed = false
  let emitted = false
  let idleTimer: ReturnType<typeof setTimeout> | undefined
  let resolveFirstEvent: (event: FirstEvent) => void = () => {}
  const firstEvent = new Promise<FirstEvent>((resolve) => {
    resolveFirstEvent = resolve
  })
  const onMessageEvent = (message: MessageEvent) => {
    void onMessage(message)
  }

  function cleanup() {
    if (idleTimer) clearTimeout(idleTimer)
    options.socket.removeEventListener("message", onMessageEvent)
    options.socket.removeEventListener("error", onError)
    options.socket.removeEventListener("close", onClose)
    options.signal?.removeEventListener("abort", onAbort)
  }

  function resetIdleTimeout(message: string) {
    if (completed || options.idleTimeoutMs <= 0) return
    if (idleTimer) clearTimeout(idleTimer)
    idleTimer = setTimeout(() => invalidate(new Error(message)), options.idleTimeoutMs)
  }

  function resolveFirst(event: FirstEvent) {
    if (emitted) return
    emitted = true
    resolveFirstEvent(event)
  }

  function invalidate(error: Error) {
    if (completed) return
    completed = true
    cleanup()
    options.onConnectionInvalid()
    resolveFirst({ kind: "invalid" })
    controller?.error(error)
  }

  function finish(event: Record<string, unknown>) {
    if (completed) return
    completed = true
    cleanup()
    options.onTerminal(event)
    controller?.enqueue(encoder.encode("data: [DONE]\n\n"))
    controller?.close()
  }

  async function onMessage(message: MessageEvent) {
    if (completed) return
    const text = await messageText(message.data)
    if (text === undefined) {
      invalidate(new Error("Unexpected binary WebSocket frame"))
      return
    }

    const event = parseJsonObject(text)
    const wrappedError = parseWrappedError(event, text)
    if (wrappedError) {
      if (!emitted) {
        completed = true
        cleanup()
        options.onTerminal(event ?? { type: "error" })
        resolveFirst({ kind: "error", error: wrappedError })
        controller?.error(new Error(wrappedError.body))
        return
      }
      invalidate(new Error(wrappedError.body))
      return
    }

    resetIdleTimeout("idle timeout waiting for websocket")

    if (event && !shouldForwardEventToSdk(event)) return

    resolveFirst({ kind: "ok" })
    controller?.enqueue(encoder.encode(toServerSentEvent(text)))

    if (!event) return
    if (isTerminalEvent(event)) finish(event)
  }

  function onError() {
    invalidate(new Error("WebSocket stream error"))
  }

  function onClose(event: CloseEvent) {
    if (completed) return
    invalidate(new Error(closeMessage("WebSocket closed before response.completed", event)))
  }

  function onAbort() {
    if (completed) return
    completed = true
    cleanup()
    terminate(options.socket)
    options.onAbort()
    resolveFirst({ kind: "invalid" })
    controller?.error(abortError(options.signal))
  }

  const response = new Response(
    new ReadableStream<Uint8Array>({
      start(next) {
        controller = next
        options.socket.addEventListener("message", onMessageEvent)
        options.socket.addEventListener("error", onError, { once: true })
        options.socket.addEventListener("close", onClose, { once: true })
        options.signal?.addEventListener("abort", onAbort, { once: true })

        if (options.signal?.aborted) {
          onAbort()
          return
        }

        const payload = { type: "response.create", ...options.body }
        resetIdleTimeout("idle timeout sending websocket request")
        try {
          options.socket.send(JSON.stringify(payload))
          resetIdleTimeout("idle timeout waiting for websocket")
        } catch (error) {
          invalidate(error instanceof Error ? error : new Error(String(error)))
        }
      },
      cancel(reason) {
        if (completed) return
        completed = true
        cleanup()
        terminate(options.socket)
        options.onAbort()
        resolveFirst({ kind: "invalid" })
        const error = reason instanceof Error ? reason : new Error(String(reason))
        controller?.error(error)
      },
    }),
    {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    }
  )

  return { response, firstEvent }
}

async function messageText(data: unknown): Promise<string | undefined> {
  if (typeof data === "string") return data
  if (data instanceof ArrayBuffer) return undefined
  if (data instanceof Blob) return data.text()
  if (ArrayBuffer.isView(data)) return undefined
  return undefined
}

function toServerSentEvent(text: string): string {
  return `${text
    .split(/\r?\n/)
    .map((line) => `data: ${line}`)
    .join("\n")}\n\n`
}

function parseJsonObject(text: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(text) as unknown
    return isRecord(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

function parseWrappedError(
  event: Record<string, unknown> | undefined,
  body: string
): WrappedError | undefined {
  if (event?.["type"] !== "error") return undefined
  if (connectionLimitReached(event)) {
    return { status: 409, body }
  }

  const status = event["status"] ?? event["status_code"]
  if (typeof status !== "number" || (status >= 200 && status < 300)) return undefined
  const headers = isRecord(event["headers"])
    ? Object.fromEntries(
        Object.entries(event["headers"]).flatMap(([key, value]) => {
          if (["string", "number", "boolean"].includes(typeof value)) {
            return [[key, String(value)]]
          }
          return []
        })
      )
    : undefined
  return { status, headers, body }
}

function connectionLimitReached(event: Record<string, unknown>): boolean {
  return isRecord(event["error"]) &&
    event["error"]["code"] === CONNECTION_LIMIT_REACHED_CODE
}

function shouldForwardEventToSdk(event: Record<string, unknown>): boolean {
  const type = event["type"]
  return !(typeof type === "string" && type.startsWith("codex."))
}

function isTerminalEvent(event: Record<string, unknown>): boolean {
  return event["type"] === "response.completed" ||
    event["type"] === "response.done" ||
    event["type"] === "response.failed" ||
    event["type"] === "response.incomplete" ||
    event["type"] === "error"
}

function isSuccessfulTerminal(event: Record<string, unknown>): boolean {
  return event["type"] === "response.completed" || event["type"] === "response.done"
}

function invalidate(entry: PoolEntry) {
  if (entry.socket) terminate(entry.socket)
  entry.socket = undefined
  entry.connectedAt = undefined
}

function terminate(socket: WebSocket) {
  try {
    socket.close()
  } catch {
    // Best effort cleanup only.
  }
}

function closeMessage(message: string, event: CloseEvent): string {
  const details = [`code ${event.code}`]
  if (event.code === 1009) details.push("message too big")
  if (event.reason.length > 0) details.push(event.reason)
  return `${message} (${details.join(": ")})`
}

function abortError(signal: AbortSignal | undefined): DOMException {
  const reason = signal?.reason
  if (reason instanceof DOMException && reason.name === "AbortError") return reason
  const message = reason instanceof Error ? reason.message : "Aborted"
  return new DOMException(message, "AbortError")
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
