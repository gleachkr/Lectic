import { randomUUID } from "node:crypto"
import type { BackendResult } from "./result"
import type { Completion, ProviderDiagnostic } from "./provider"

export type Outcome = "received" | "awaiting_context" | "running"
  | BackendResult["status"] | "cancelled" | "expired" | "rejected"
export type Delivery = "pending" | "withheld" | "sent"
  | "acknowledged" | "uncertain" | "not_sent"
export type Task = {
  delegationId: string
  runId?: string
  revision: number
  contextRevision?: number
  received: number
  outcome: Outcome
  delivery: Delivery
  resolution?: { outcome: Completion["outcome"]; delivery: Delivery }
  providerCancelled?: boolean
  result?: BackendResult
  context?: string
  reason?: "context_changed" | "new_delegation" | "context_lost"
}

export type DiagnosticCode = "delegation_received" | "duplicate"
  | "request_invalid" | "queue_full" | "queue_expired"
  | "context_missing" | "context_lost"
  | "backend_started" | "backend_completed" | "backend_failed"
  | "result_withheld" | "result_sent" | "result_acknowledged"
  | "delivery_uncertain" | "cancelled" | "context_cleared"
  | "sideband_lost" | "browser_lost" | "budget_reached"
  | "startup_failed" | "ended" | "finalization_uncertain"
  | "provider_diagnostic"
  | "event_limit" | "live_error" | "startup_timeout"
  | "idle_disconnected" | "idle_resumed" | "idle_terminal"
  | "invalid_local_audio_or_overload" | "provider_limit" | "transport_lost"

// Metadata only: no provider errors, transcript, opaque remote IDs, paths,
// arguments, or summaries. This remains usable regardless of tool policy.
export class Journal {
  constructor(
    readonly conversationId: string = randomUUID(),
    private changed?: () => void,
  ) {}
  private sequence = 0
  private events: {
    sequence: number; at: number; code: DiagnosticCode
    revision?: number; detail?: ProviderDiagnostic
  }[] = []

  add(code: DiagnosticCode, revision?: number,
    detail?: ProviderDiagnostic) {
    this.events.push({ sequence: ++this.sequence, at: Date.now(),
      code, revision, ...(detail ? { detail } : {}) })
    if (this.events.length > 256) this.events.shift()
    this.changed?.()
  }

  snapshot() { return this.events.map(event => ({ ...event })) }
}

export class Usage {
  private currentSeconds = 0
  private previousSeconds = 0
  private previousBillable = 0
  private rejected = false
  final = false

  get seconds() { return this.previousSeconds + this.currentSeconds }

  // Called only after a confirmed idle close, immediately before creation.
  nextSession() {
    this.previousSeconds += this.currentSeconds
    this.previousBillable += Math.max(15, this.currentSeconds)
    this.currentSeconds = 0
    this.final = false
    this.finalSeconds = undefined
  }
  private finalSeconds?: number

  // No session was created. Preserve prior confirmed sessions, but remove
  // the speculative minimum reserved for this creation attempt.
  rejectCreation() {
    this.rejected = true
    this.currentSeconds = 0
    this.final = true
    this.finalSeconds = this.previousSeconds
  }

  update(seconds: number, final = false) {
    // Delayed cumulative snapshots must not reduce elapsed usage. A terminal
    // snapshot is authoritative; late nonterminal events cannot replace it.
    if (this.final) return
    if (final) {
      this.final = true
      this.finalSeconds = this.previousSeconds + seconds
    }
    this.currentSeconds = final ? seconds
      : Math.max(this.currentSeconds, seconds)
  }

  snapshot(attempted: boolean) {
    const billable = this.previousBillable
      + (attempted && !this.rejected
        ? Math.max(15, this.currentSeconds) : 0)
    return {
      seconds: this.seconds, final: this.final,
      finalSeconds: this.finalSeconds,
      estimatedBillableSeconds: billable,
      estimatedVoiceCost: billable / 60 * .05,
      backendCost: null,
    }
  }
}
