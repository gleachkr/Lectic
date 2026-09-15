import { randomUUID } from "node:crypto"
import type { BackendResult } from "./result"

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
  result?: BackendResult
  context?: string
  reason?: "context_changed" | "new_delegation" | "context_lost"
}

export type DiagnosticCode = "delegation_received" | "duplicate"
  | "queue_full" | "queue_expired" | "context_missing" | "context_lost"
  | "backend_started" | "backend_completed" | "backend_failed"
  | "result_withheld" | "result_sent" | "result_acknowledged"
  | "delivery_uncertain" | "cancelled" | "context_cleared"
  | "sideband_lost" | "browser_lost" | "budget_reached"
  | "startup_failed" | "ended" | "finalization_uncertain"
  | "event_limit" | "live_error" | "startup_timeout"

// Metadata only: no provider errors, transcript, opaque remote IDs, paths,
// arguments, or summaries. This remains usable regardless of tool policy.
export class Journal {
  constructor(
    readonly conversationId: string = randomUUID(),
    private changed?: () => void,
  ) {}
  private sequence = 0
  private events: {
    sequence: number; at: number; code: DiagnosticCode; revision?: number
  }[] = []

  add(code: DiagnosticCode, revision?: number) {
    this.events.push({ sequence: ++this.sequence, at: Date.now(),
      code, revision })
    if (this.events.length > 256) this.events.shift()
    this.changed?.()
  }

  snapshot() { return this.events.map(event => ({ ...event })) }
}

export class Usage {
  seconds = 0
  final = false
  private finalSeconds?: number

  update(seconds: number, final = false) {
    // Delayed cumulative snapshots must not reduce elapsed usage. A terminal
    // snapshot is authoritative; late nonterminal events cannot replace it.
    if (this.final) return
    if (final) {
      this.final = true
      this.finalSeconds = seconds
    }
    this.seconds = final ? seconds : Math.max(this.seconds, seconds)
  }

  snapshot(attempted: boolean) {
    const billable = attempted ? Math.max(15, this.seconds) : 0
    return {
      seconds: this.seconds, final: this.final,
      finalSeconds: this.finalSeconds,
      estimatedBillableSeconds: billable,
      estimatedVoiceCost: billable / 60 * .05,
      backendCost: null,
    }
  }
}
