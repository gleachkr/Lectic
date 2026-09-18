import type { HistoryContext } from "./history"
import type { BackendResult } from "./result"

export class SessionFailure extends Error {}
// Explicit request rejection, unlike a timeout or failed attachment.
export class CreationRejected extends SessionFailure {}

export type Provider = "openai" | "gemini"
// IDs are opaque and scoped to one provider session, never globally unique.
export type Owner = {
  provider: Provider
  sessionId: string
  sessionIdSource: "provider" | "local"
}
export function sameOwner(a: Owner, b: Owner) {
  return a.provider === b.provider && a.sessionId === b.sessionId
    && a.sessionIdSource === b.sessionIdSource
}

type Observation = {
  owner: Owner
  // Only adapters may assert identity. Never deduplicate by transcript text.
  identity?: string
}
export type TranscriptObservation = Observation & {
  type: "transcript"
  speaker: "user" | "assistant"
  text: string
  interim?: boolean
  // Provider media time, when available; NOT local receipt time or order.
  media?: { startMs: number; endMs: number }
  eventId?: string
}
export type BackendRequest = Observation & {
  type: "request"
  requestId: string
  task?: string
  offsetMs?: number
}
export type Cancellation = Observation & {
  type: "cancel"
  requestId: string
}
export type WorkObservation = TranscriptObservation | BackendRequest
  | Cancellation
export type UsageObservation = Observation & {
  type: "usage"
  completeness: "partial" | "final"
} & ({ unit: "seconds"; seconds: number } | {
  unit: "tokens"; counters: Readonly<Record<string, number>>
})
export type CloseState = {
  transport: "open" | "closed"
  remote: "unknown" | "ended"
  usage: "unknown" | "partial" | "final"
}
// Adapter-owned, bounded metadata. Never raw provider payloads or URLs.
export type ProviderDiagnostic = {
  source: "provider" | "protocol" | "transport"
  code: string
  closeCode?: number
  wasClean?: boolean
}
export type ProviderObservation = WorkObservation | UsageObservation
  | (Observation & { type: "started" })
  | (Observation & { type: "lifecycle"; state: CloseState })
  | (Observation & { type: "diagnostic"; detail: ProviderDiagnostic })
  | (Observation & { type: "error"; reason?: "provider_limit"
    detail?: ProviderDiagnostic })

// Transmission is not acknowledgment, and neither confirms audible playback.
export type DeliveryReceipt = {
  transmission: "sent" | "not_sent" | "unknown"
  acknowledgment: "acknowledged" | "unavailable" | "unknown"
}
export type CompletionResult = {
  outcome: BackendResult["status"]; summary: string
} | {
  outcome: "rejected" | "expired" | "cancelled" | "superseded"
}
export type Completion = CompletionResult & {
  owner: Owner
  requestId: string
}
export type Complete = (completion: Completion) => Promise<DeliveryReceipt>

export type PCMOutput = Uint8Array | "flush"
export type SessionMedia = { kind: "webrtc"; sdp: string } | {
  kind: "pcm"
  capture(pcm: Uint8Array, rate: number): void
  attach(send: (output: PCMOutput) => void): void
}

// SDP is used only by WebRTC; PCM capture declares its native rate locally.
export interface ProviderSession {
  owner: Owner
  media: SessionMedia
  complete: Complete
  close(): Promise<CloseState>
  bootstrap(raw: string[]): ProviderObservation[]
}
export type ProviderConnect = (
  sdp: string,
  receive: (event: ProviderObservation) => void,
  lost: () => void,
  signal: AbortSignal,
  previousSession?: HistoryContext,
) => Promise<ProviderSession>

export const MAX_TASK_BYTES = 8192
export function validTask(task: string | undefined) {
  return task === undefined || (typeof task === "string"
    && task.trim().length > 0
    && Buffer.byteLength(task) <= MAX_TASK_BYTES)
}

// Unknown/partial usage stays distinct even after a clean transport close.
export class Lifecycle {
  private value: CloseState = {
    transport: "open", remote: "unknown", usage: "unknown",
  }
  observe(state: CloseState) {
    if (state.transport === "closed") this.value.transport = "closed"
    if (state.remote === "ended") this.value.remote = "ended"
    if (state.usage === "final" || this.value.usage === "unknown") {
      this.value.usage = state.usage
    }
  }
  snapshot(): CloseState { return { ...this.value } }
}
