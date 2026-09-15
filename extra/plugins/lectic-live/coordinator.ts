import { createHash, randomUUID } from "node:crypto"
import type {
  DelegationEvent, LiveEvent, TranscriptEvent,
} from "./protocol"
import { snapshot, serializeContext, type ContextEnvelope }
  from "./transcript"
import type { BackendResult } from "./result"
import { Journal, type Task } from "./state"
import { boundHistory, type HistoryContext } from "./history"

export type Backend = (
  context: ContextEnvelope, signal: AbortSignal,
) => Promise<BackendResult>

type Fragment = { event: TranscriptEvent; sequence: number; received: number }
type Pending = { event: DelegationEvent; task: Task }
export type CoordinatorOptions = {
  settleMs?: number
  queueMs?: number
  contextSeconds?: number
  now?: () => number
  journal?: Journal
  previousSession?: HistoryContext
  changed?: () => void
}

export class Coordinator {
  private fragments: Fragment[] = []
  private tasks: Task[] = []
  private seen = new Set<string>()
  private seenSpeech = new Set<string>()
  private queue: Pending[] = []
  private active?: AbortController
  private stopped = false
  private draining = false
  private revision = 0
  private speechRevision = 0
  private sequence = 0
  private contextLost = false
  private previousSession?: HistoryContext
  private changed?: () => void
  private settleMs: number
  private queueMs: number
  private contextMs: number
  private now: () => number
  readonly journal: Journal
  runs = 0
  status = "Idle — waiting for delegation"

  constructor(
    private sessionId: string,
    private backend: Backend,
    private deliver: (id: string, content: string) => Promise<void>,
    options: CoordinatorOptions | number = {},
  ) {
    const config = typeof options === "number"
      ? { settleMs: options } : options
    this.settleMs = config.settleMs ?? 750
    this.queueMs = config.queueMs ?? 60_000
    this.contextMs = (config.contextSeconds ?? 300) * 1000
    this.now = config.now ?? Date.now
    this.journal = config.journal ?? new Journal(
      config.previousSession?.conversationId,
    )
    this.previousSession = config.previousSession
    this.changed = config.changed
  }

  receive(event: LiveEvent) {
    if (this.stopped) return
    this.prune()
    if (event.type === "session.input_transcript.delta"
      || event.type === "session.output_transcript.delta") {
      const key = event.event_id ? `id:${event.event_id}`
        : createHash("sha256").update(JSON.stringify(event)).digest("hex")
      if (this.seenSpeech.has(key)) return
      if (this.seenSpeech.size >= 8192) {
        this.stop()
        this.journal.add("event_limit")
        return
      }
      this.seenSpeech.add(key)
      this.fragments.push({ event, sequence: ++this.sequence,
        received: this.now() })
      if (event.type === "session.input_transcript.delta"
        && event.delta.trim()) this.speechRevision++
      this.prune()
      this.changed?.()
    } else if (event.type === "session.delegation.created"
      && event.delegation.target === "client") {
      const id = event.delegation.id
      if (this.seen.has(id)) {
        this.journal.add("duplicate")
        return
      }
      // Never evict execution tombstones during the bounded session.
      if (this.seen.size >= 256) throw new Error("Delegation limit reached")
      this.seen.add(id)
      const task: Task = {
        delegationId: id, received: this.now(), revision: ++this.revision,
        outcome: "received", delivery: "pending",
      }
      this.tasks.push(task)
      this.journal.add("delegation_received", task.revision)
      if (this.queue.length >= 4) {
        task.outcome = "rejected"
        task.delivery = "not_sent"
        this.journal.add("queue_full", task.revision)
        this.status = "Queue full — cancel work before asking again"
        return
      }
      this.queue.push({ event, task })
      void this.drain()
    }
  }

  historyContext(): HistoryContext {
    return boundHistory({
      version: 1, conversationId: this.journal.conversationId,
      incomplete: this.contextLost || !!this.previousSession?.incomplete,
      fragments: [
        ...(this.previousSession?.fragments ?? []),
        ...this.fragments.map(({ event, sequence }) => ({
          sessionId: this.sessionId, sequence,
          speaker: event.type === "session.input_transcript.delta"
            ? "user" : "assistant",
          text: event.delta,
        })),
      ],
      tasks: [
        ...(this.previousSession?.tasks ?? []),
        ...this.tasks.map(task => ({ ...task, sessionId: this.sessionId })),
      ],
    })
  }

  // Browser diagnostics are a compact lifecycle view, not the local archive.
  diagnostics() {
    this.prune()
    return this.tasks.map(t => ({
      revision: t.revision, contextRevision: t.contextRevision,
      outcome: t.outcome, delivery: t.delivery, reason: t.reason,
    }))
  }

  cancel() {
    this.revision++
    for (const { task } of this.queue) {
      task.outcome = "cancelled"
      task.delivery = "not_sent"
    }
    this.queue = []
    this.active?.abort()
    this.journal.add("cancelled")
    this.status = "Backend cancelled — "
      + "actions may already have happened; results cannot be recalled"
  }

  clearContext() {
    this.cancel()
    this.fragments = []
    for (const task of this.tasks) {
      delete task.context
      delete task.result
    }
    this.contextLost = false
    this.previousSession = undefined
    this.journal.add("context_cleared")
    this.status = "Context cleared — restate the next request in full"
  }

  stop() {
    if (this.stopped) return
    this.stopped = true
    this.cancel()
  }

  get busy() { return this.draining || this.queue.length > 0 }

  async idle() {
    while (this.draining) await Bun.sleep(10)
  }

  private prune() {
    const cutoff = this.now() - this.contextMs
    while (this.fragments.length && (this.fragments[0].received < cutoff
      || this.fragments.length > 96
      || Buffer.byteLength(JSON.stringify(this.fragments)) > 16_000)) {
      const removed = this.fragments.shift()!
      if (removed.event.type === "session.input_transcript.delta"
        && removed.event.delta.trim()) this.contextLost = true
    }
    // Bound retained public results and request snapshots, not tombstones.
    const retained = this.tasks.filter(t => t.result || t.context)
    for (const task of retained) {
      if (task.received < cutoff
        || retained.indexOf(task) < retained.length - 8) {
        this.contextLost = true
        delete task.result
        delete task.context
      }
    }
  }

  private async drain() {
    if (this.draining) return
    this.draining = true
    try {
      while (this.queue.length && !this.stopped) {
        const { event, task } = this.queue.shift()!
        const controller = new AbortController()
        this.active = controller
        task.outcome = "awaiting_context"
        this.status = "Settling speech context"
        await new Promise<void>(resolve => {
          const done = () => {
            clearTimeout(timer)
            controller.signal.removeEventListener("abort", done)
            resolve()
          }
          const timer = setTimeout(done, this.settleMs)
          controller.signal.addEventListener("abort", done, { once: true })
        })
        if (controller.signal.aborted || this.stopped) {
          task.outcome = "cancelled"
          task.delivery = "not_sent"
          continue
        }
        this.prune()
        task.contextRevision = this.speechRevision
        const id = task.delegationId
        let result: BackendResult
        if (this.now() - task.received > this.queueMs) {
          task.outcome = "expired"
          task.delivery = "not_sent"
          this.journal.add("queue_expired", task.revision)
          this.status = "Queued request expired — please ask again"
          continue
        }
        try {
          const context = snapshot(
            this.journal.conversationId, this.sessionId, event,
            this.fragments.map(f => f.event),
          )
          context.fragments.forEach((f, i) => {
            f.sequence = this.fragments[i].sequence
          })
          context.contextIncomplete = this.contextLost
          context.previousSession = this.previousSession
          context.taskRevision = task.revision
          context.contextRevision = task.contextRevision
          context.runId = task.runId = randomUUID()
          context.backendHistory = this.tasks.filter(t =>
            t !== task && (t.result || (t.runId && t.context)))
            .slice(this.previousSession ? -4 : -8).map(t => ({
              delegationId: t.delegationId, runId: t.runId,
              revision: t.revision, contextRevision: t.contextRevision,
              summary: t.result?.summary
                ?? "No confirmed result; actions may already have happened. "
                  + "Check actual state before retrying.",
              status: t.result?.status ?? "failed",
              outcome: t.outcome,
              delivery: t.delivery, reason: t.reason,
              requestContext: t.context,
            }))
          // The request associated with a finding is needed to reconcile it.
          // Keep a bounded excerpt, explicitly marked as incomplete.
          const request = JSON.stringify(context.fragments)
          task.context = Buffer.byteLength(request) <= 1200 ? request
            : "[request excerpt truncated] "
              + Buffer.from(request).subarray(-1200).toString("utf8")
          // Make room for current speech before dropping the entire request.
          while (Buffer.byteLength(JSON.stringify(context)) > 32 * 1024
            && context.backendHistory.length) {
            context.backendHistory.shift()
            context.contextIncomplete = true
          }
          serializeContext(context)
          this.status = "Running Lectic"
          task.outcome = "running"
          this.journal.add("backend_started", task.revision)
          this.runs++
          result = await this.backend(context, controller.signal)
          // Validate even alternate runners before retaining or delivering.
          if (!result.summary.trim()
            || Buffer.byteLength(result.summary) > 400
            || !["completed", "failed", "clarification"]
              .includes(result.status)) {
            throw new Error("Invalid backend result")
          }
          this.journal.add("backend_completed", task.revision)
        } catch (error) {
          const missing = task.outcome !== "running"
          if (!missing && !controller.signal.aborted) {
            console.error("lectic live: backend task:", error)
          }
          result = {
            status: missing ? "clarification" : "failed",
            summary: missing
              ? "Please clarify the request; no user context is available."
              : "No confirmed backend result. Actions may already have "
                + "happened; check actual state before retrying.",
          }
          this.journal.add(missing
            ? this.contextLost ? "context_lost" : "context_missing"
            : "backend_failed", task.revision)
        }
        if (this.stopped || controller.signal.aborted) {
          task.outcome = "cancelled"
          task.delivery = "not_sent"
          continue
        }
        task.outcome = result.status
        task.result = result
        this.changed?.()
        this.prune()
        if (task.revision !== this.revision
          || task.contextRevision !== this.speechRevision) {
          task.delivery = "withheld"
          task.reason = task.revision !== this.revision
            ? "new_delegation" : "context_changed"
          this.journal.add("result_withheld", task.revision)
          this.status = "Result withheld: context changed. "
            + "Actions may have happened; reconcile before retrying."
          continue
        }
        this.status = "Result sent — awaiting acknowledgment"
        task.delivery = "sent"
        this.journal.add("result_sent", task.revision)
        try {
          await this.deliver(id, result.summary)
          task.delivery = "acknowledged"
          this.journal.add("result_acknowledged", task.revision)
          if (!controller.signal.aborted && !this.stopped) {
            this.status = `Result acknowledged (${result.status}); `
              + "playback is not confirmed"
          }
        } catch {
          task.delivery = "uncertain"
          this.journal.add("delivery_uncertain", task.revision)
          if (!controller.signal.aborted && !this.stopped) {
            this.status = "Result delivery uncertain — not retried"
          }
        }
      }
    } finally {
      this.active = undefined
      this.draining = false
      this.changed?.()
    }
  }
}
