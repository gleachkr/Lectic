import { geminiHistory } from "./gemini-history"
import { randomUUID } from "node:crypto"
import { frameSamples } from "./gemini-audio"
import { decode, GeminiWireError, toolResult } from "./gemini-wire"
import {
  sameOwner, SessionFailure, type CloseState, type Owner, type PCMOutput,
  type ProviderConnect, type ProviderSession, type ProviderDiagnostic,
} from "./provider"

import { geminiVoicePrompt } from "./prompts"

export type GeminiSocket = {
  readyState: number
  bufferedAmount: number
  send(data: string): void
  close(): void
  onopen: (() => void) | null
  onmessage: ((event: { data: unknown }) => void) | null
  onerror: (() => void) | null
  onclose: ((event?: {
    code: number; reason: string; wasClean: boolean
  }) => void) | null
}

export function geminiSetup(voice = "Kore") {
  if (!/^[A-Z][A-Za-z0-9_-]{0,63}$/.test(voice)) {
    throw new SessionFailure("Invalid Gemini voice name")
  }
  return { setup: {
    model: "models/gemini-3.8-live",
    generationConfig: {
      responseModalities: ["AUDIO"],
      speechConfig: {
        voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } },
      },
    },
    inputAudioTranscription: {}, outputAudioTranscription: {},
    systemInstruction: { parts: [{ text: geminiVoicePrompt }] },
    tools: [{ functionDeclarations: [{
      name: "delegate", behavior: "NON_BLOCKING",
      description: "Ask the configured Lectic backend to perform a task.",
      parameters: { type: "OBJECT", properties: {
        task: { type: "STRING" },
      }, required: ["task"] },
    }] }],
  } }
}

// No credentials are read and no connection is made until explicitly called.
export function geminiConnector(
  key: string, voice?: string,
  socketFactory: () => GeminiSocket = () => {
    const endpoint = "wss://generativelanguage.googleapis.com/ws/"
      + "google.ai.generativelanguage.v1alpha."
      + "GenerativeService.BidiGenerateContent"
    const socket = new WebSocket(`${endpoint}?key=${encodeURIComponent(key)}`)
    socket.binaryType = "arraybuffer"
    return socket as unknown as GeminiSocket
  },
  timeoutMs = 15000,
): ProviderConnect {
  const setup = geminiSetup(voice)
  return async (_sdp, receive, lost, signal, previous) => {
    if (signal.aborted) throw new SessionFailure("Gemini startup cancelled")
    let socket: GeminiSocket
    try { socket = socketFactory() } catch {
      throw new SessionFailure("Gemini connection failed")
    }
    const owner: Owner = {
      provider: "gemini", sessionId: randomUUID(), sessionIdSource: "local",
    }
    // Retain tombstones for the whole owner lifetime, including unknown
    // cancellations. Never evict an ID and accidentally execute it again.
    const calls = new Map<string, "pending" | "settled" | "cancelled">()
    function reserve(id: string) {
      if (!calls.has(id) && calls.size >= 256) {
        throw new GeminiWireError("Call retention limit")
      }
    }
    let ended = false
    let ready = false
    let opened = false
    let output: ((value: PCMOutput) => void) | undefined
    let usage: CloseState["usage"] = "unknown"
    let transport: CloseState["transport"] = "open"
    let resolve!: (session: ProviderSession) => void
    let reject!: (error: Error) => void
    let closeResolve: (() => void) | undefined
    let closePromise: Promise<CloseState> | undefined
    const state = (): CloseState => ({
      transport, remote: "unknown", usage,
    })
    const startup = new Promise<ProviderSession>((yes, no) => {
      resolve = yes
      reject = no
    })
    const timer = setTimeout(() => {
      fail("Gemini startup timed out")
    }, timeoutMs)

    function stop() {
      if (ended) return
      ended = true
      clearTimeout(timer)
      signal.removeEventListener("abort", abort)
      reject(new SessionFailure("Gemini startup cancelled"))
      // Stop audio immediately; a socket close is not final provider usage.
      try { output?.("flush") } catch { /* Browser may already be gone. */ }
      try { socket.close() } catch { /* Never reflect raw errors. */ }
    }
    function fail(message: string, reason?: "provider_limit",
      detail: ProviderDiagnostic = { source: "transport", code: message }) {
      if (ended) return
      reject(new SessionFailure(message))
      stop()
      if (ready) {
        try { receive({ type: "error", owner, reason, detail }) }
        finally { lost() }
      }
    }
    function abort() { stop() }
    signal.addEventListener("abort", abort, { once: true })
    function send(value: unknown, attempting?: () => void) {
      const raw = JSON.stringify(value)
      if (ended || socket.readyState !== 1
        || socket.bufferedAmount + Buffer.byteLength(raw) > 256000) {
        throw new Error("Gemini transport unavailable or overloaded")
      }
      attempting?.()
      socket.send(raw)
    }
    const session: ProviderSession = {
      owner,
      media: {
        kind: "pcm",
        attach(sink) {
          if (output || ended) throw new Error("Gemini media already owned")
          output = sink
        },
        capture(pcm, rate) {
          try {
            if (!ready || ended
              || pcm.byteLength !== frameSamples(rate) * 2) {
              throw new Error("Invalid capture frame or readiness")
            }
            send({ realtimeInput: { audio: {
              mimeType: `audio/pcm;rate=${rate}`,
              data: Buffer.from(pcm).toString("base64"),
            } } })
          } catch {
            fail("Gemini audio transport failed")
            throw new SessionFailure("Gemini audio transport failed")
          }
        },
      },
      async complete(completion) {
        if (!sameOwner(owner, completion.owner)) {
          throw new Error("Wrong Gemini completion owner")
        }
        const id = completion.requestId
        if (calls.get(id) !== "pending") {
          return { transmission: "not_sent", acknowledgment: "unavailable" }
        }
        calls.set(id, "settled")
        if (ended || !ready) {
          return { transmission: "not_sent", acknowledgment: "unavailable" }
        }
        const statuses = {
          rejected: "Request rejected; no backend work started "
            + "for this call.",
          expired: "Request expired in the queue; no backend work started.",
          cancelled: "Local work cancelled. Actions may already have "
            + "happened; verify actual state before retrying.",
          superseded: "Result withheld for an older request. Do not speak "
            + "it as the corrected answer. Actions may have happened; "
            + "the backend retains findings for reconciliation.",
        }
        const text = "summary" in completion
          ? `${completion.outcome}: ${completion.summary}`
          : statuses[completion.outcome]
        let attempted = false
        try {
          send(toolResult(id, text), () => { attempted = true })
          return {
            transmission: calls.get(id) === "cancelled" ? "unknown" : "sent",
            acknowledgment: "unavailable",
          }
        } catch {
          // Even a throwing send may have transmitted bytes. Never retry.
          fail("Gemini result transport failed")
          return { transmission: attempted ? "unknown" : "not_sent",
            acknowledgment: "unavailable" }
        }
      },
      bootstrap(raw) {
        if (raw.length) throw new Error("PCM has no browser provider events")
        return []
      },
      close() {
        if (closePromise) return closePromise
        closePromise = (async () => {
          const closed = new Promise<void>(done => { closeResolve = done })
          stop()
          if (transport !== "closed") {
            let timer: ReturnType<typeof setTimeout> | undefined
            await Promise.race([closed, new Promise<void>(done => {
              timer = setTimeout(done, 250)
            })])
            clearTimeout(timer)
          }
          // Retire callbacks even when the close handshake did not finish.
          socket.onopen = socket.onmessage = socket.onerror = null
          socket.onclose = null
          return state()
        })()
        return closePromise
      },
    }
    socket.onopen = () => {
      if (ended) {
        try { socket.close() } catch { /* No raw errors. */ }
        return
      }
      try {
        if (opened) throw new Error("Duplicate socket open")
        opened = true
        send(previous ? { setup: { ...setup.setup,
          historyConfig: { initialHistoryInClientContent: true },
        } } : setup)
      } catch { fail("Gemini setup send failed") }
    }
    socket.onmessage = event => {
      if (ended) return
      try {
        const data = event.data
        let raw: string
        if (typeof data === "string") raw = data
        else if ((data instanceof ArrayBuffer || data instanceof Uint8Array)
          && data.byteLength <= 512 * 1024) {
          raw = new TextDecoder("utf-8", { fatal: true }).decode(data)
        } else throw new Error("Invalid provider frame")
        for (const event of decode(raw)) {
          if (ended) break
          if (event.type === "setup") {
            if (!opened || ready) throw new Error("Unexpected setup")
            ready = true
            clearTimeout(timer)
            receive({ type: "started", owner })
            if (previous) {
              // Only this initial-history handshake avoids generation.
              // Finish it before startup resolves or microphone PCM flows.
              send(geminiHistory(previous))
            }
            resolve(session)
          } else if (event.type === "goAway") {
            fail("Gemini provider connection limit",
              "provider_limit")
          } else {
            if (!ready) throw new Error("Event before setup")
            switch (event.type) {
              case "turnReason":
                receive({ type: "diagnostic", owner, detail: {
                  source: "provider", code: event.reason,
                } })
                break
              case "audio":
                if (!output) throw new Error("Audio before media attachment")
                output(event.pcm)
                break
              case "interrupted": output?.("flush"); break
              case "input": case "output":
                receive({ type: "transcript", owner, text: event.text,
                  speaker: event.type === "input" ? "user" : "assistant" })
                break
              case "usage":
                usage = "partial"
                receive({ type: "usage", owner, unit: "tokens",
                  completeness: "partial", counters: event.counters })
                break
              case "call": {
                const { id, task } = event.call
                reserve(id)
                if (calls.has(id)) break
                calls.set(id, "pending")
                receive({ type: "request", owner, requestId: id, task })
                break
              }
              case "cancel":
                reserve(event.id)
                if (calls.get(event.id) === "cancelled") break
                // Invalidate before notifying work, so synchronous cleanup
                // cannot send a response for an already cancelled call.
                calls.set(event.id, "cancelled")
                receive({ type: "cancel", owner, requestId: event.id })
                break
            }
          }
        }
      } catch (error) {
        fail("Gemini protocol or transport failure", undefined, {
          source: error instanceof GeminiWireError ? "protocol" : "transport",
          code: error instanceof GeminiWireError ? error.message
            : "Provider event handling failed",
        })
      }
    }
    socket.onerror = () => fail("Gemini connection failed")
    socket.onclose = event => {
      transport = "closed"
      closeResolve?.()
      // Classify only; arbitrary close text can contain credentials or
      // user content. A clean WebSocket close is not final usage.
      const reason = event?.reason.slice(0, 256) ?? ""
      const category = /recitation/i.test(reason) ? "recitation"
        : /safety|prohibited/i.test(reason) ? "safety"
          : /quota|resource.exhausted/i.test(reason) ? "quota"
            : "unspecified"
      fail("Gemini connection closed; usage unconfirmed", undefined, {
        source: "provider", code: `WebSocket closed (${category})`,
        ...(event && Number.isInteger(event.code) ? {
          closeCode: event.code, wasClean: event.wasClean,
        } : {}),
      })
    }
    // Cover abort during a socket factory without leaving startup alive.
    if (signal.aborted) abort()
    return startup
  }
}
