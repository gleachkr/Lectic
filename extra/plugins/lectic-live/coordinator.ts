import { randomUUID } from "node:crypto"
import {
  sameOwner, validTask, type BackendRequest, type Complete,
  type CompletionResult, type Owner, type TranscriptObservation,
  type WorkObservation,
} from "./provider"
import { snapshot, serializeContext, type ContextEnvelope }
  from "./transcript"
import { MAX_RESULT_BYTES, type BackendResult } from "./result"
import { describeBackendFailure } from "./lectic-runner"
import { Journal, type Task } from "./state"
import { boundHistory, type HistoryContext } from "./history"

export type Backend = (
  context: ContextEnvelope, signal: AbortSignal,
) => Promise<BackendResult>

type Fragment = {
  event: TranscriptObservation; sequence: number; received: number
}
type Pending = { event: BackendRequest; task: Task }
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
  private activeTask?: Task
  private notifications = new Set<Promise<void>>()
  private resolved = new Set<string>()
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
    private owner: Owner,
    private backend: Backend,
    private complete: Complete,
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

  receive(event: WorkObservation) {
    if (this.stopped || !sameOwner(this.owner, event.owner)) return
    this.prune()
    if (event.type === "cancel") {
      this.cancelRequest(event.requestId)
    } else if (event.type === "transcript") {
      if (event.interim) return
      const key = event.identity
      if (key && this.seenSpeech.has(key)) return
      if (this.seenSpeech.size >= 8192) {
        this.stop()
        this.journal.add("event_limit")
        return
      }
      if (key) this.seenSpeech.add(key)
      this.fragments.push({ event, sequence: ++this.sequence,
        received: this.now() })
      if (event.speaker === "user"
        && event.text.trim()) this.speechRevision++
      this.prune()
      this.changed?.()
    } else if (event.type === "request") {
      const id = event.requestId
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
      const invalid = !validTask(event.task)
      if (invalid || this.queue.length >= 4) {
        task.outcome = "rejected"
        task.delivery = "not_sent"
        this.journal.add(invalid ? "request_invalid" : "queue_full",
          task.revision)
        this.status = invalid ? "Invalid task — please ask again"
          : "Queue full — cancel work before asking again"
        this.resolve(task, { outcome: "rejected" })
        return
      }
      this.queue.push({ event, task })
      void this.drain()
    }
  }

  private historyOwner() {
    // Missing metadata in v1 checkpoints means an OpenAI provider ID.
    return this.owner.provider === "openai"
      && this.owner.sessionIdSource === "provider" ? {} : {
        provider: this.owner.provider,
        sessionIdSource: this.owner.sessionIdSource,
      }
  }

  historyContext(): HistoryContext {
    return boundHistory({
      version: 1, conversationId: this.journal.conversationId,
      incomplete: this.contextLost || !!this.previousSession?.incomplete,
      fragments: [
        ...(this.previousSession?.fragments ?? []),
        ...this.fragments.map(({ event, sequence }) => ({
          sessionId: this.owner.sessionId, ...this.historyOwner(), sequence,
          speaker: event.speaker, text: event.text,
        })),
      ],
      tasks: [
        ...(this.previousSession?.tasks ?? []),
        ...this.tasks.map(task => ({ ...task,
          sessionId: this.owner.sessionId, ...this.historyOwner() })),
      ],
    })
  }

  // Browser diagnostics are a compact lifecycle view, not the local archive.
  diagnostics() {
    this.prune()
    return this.tasks.map(t => ({
      revision: t.revision, contextRevision: t.contextRevision,
      outcome: t.outcome, delivery: t.delivery, reason: t.reason,
      resolution: t.resolution, providerCancelled: t.providerCancelled,
    }))
  }

  private cancelRequest(id: string) {
    const task = this.tasks.find(task => task.delegationId === id)
    if (!task || task.providerCancelled) return
    task.providerCancelled = true
    // An already sent result cannot be recalled. Keep its execution and
    // transmission facts; cancellation does not establish rollback.
    if (!this.resolved.has(id)) {
      const queued = this.queue.findIndex(p => p.task === task)
      if (queued >= 0) {
        this.queue.splice(queued, 1)
        task.outcome = "cancelled"
        task.delivery = "not_sent"
        this.resolve(task, { outcome: "cancelled" })
      } else if (this.activeTask === task) this.active?.abort()
    }
    this.journal.add("cancelled", task.revision)
    this.status = "Backend call cancelled — actions may already have happened"
    this.changed?.()
  }

  cancel() {
    this.revision++
    for (const { task } of this.queue) {
      task.outcome = "cancelled"
      task.delivery = "not_sent"
      this.resolve(task, { outcome: "cancelled" })
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

  get busy() {
    return this.draining || this.queue.length > 0
      || this.notifications.size > 0
  }

  async idle() {
    while (this.busy) await Bun.sleep(10)
  }

  private prune() {
    const cutoff = this.now() - this.contextMs
    while (this.fragments.length && (this.fragments[0].received < cutoff
      || this.fragments.length > 96
      || Buffer.byteLength(JSON.stringify(this.fragments)) > 16_000)) {
      const removed = this.fragments.shift()!
      if (removed.event.speaker === "user"
        && removed.event.text.trim()) this.contextLost = true
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

  // Every terminal request gets one adapter completion, including no-work
  // outcomes. A provider without status responses returns not_sent. Never
  // translate a settled Promise<void> into a provider acknowledgment.
  private resolve(
    task: Task,
    result: CompletionResult,
    signal?: AbortSignal,
  ): Promise<void> {
    if (this.resolved.has(task.delegationId)) return Promise.resolve()
    this.resolved.add(task.delegationId)
    const summary = "summary" in result
    task.resolution = { outcome: result.outcome, delivery: "pending" }
    const pending = (async () => {
      try {
        const receipt = await this.complete({ ...result, owner: this.owner,
          requestId: task.delegationId })
        const delivery = receipt.transmission === "not_sent" ? "not_sent"
          : receipt.transmission === "unknown" ? "uncertain"
            : receipt.acknowledgment === "acknowledged" ? "acknowledged"
              : receipt.acknowledgment === "unavailable" ? "sent"
                : "uncertain"
        task.resolution!.delivery = delivery
        if (!summary) return
        task.delivery = delivery
        if (delivery === "acknowledged") {
          this.journal.add("result_acknowledged", task.revision)
          if (!signal?.aborted && !this.stopped) {
            this.status = `Result acknowledged (${result.outcome}); `
              + "playback is not confirmed"
          }
        } else {
          if (delivery === "uncertain") {
            this.journal.add("delivery_uncertain", task.revision)
          }
          if (!signal?.aborted && !this.stopped) {
            this.status = delivery === "sent"
              ? "Result sent — provider acknowledgment unavailable"
              : delivery === "not_sent" ? "Result not sent — not retried"
                : "Result delivery uncertain — not retried"
          }
        }
      } catch {
        task.resolution!.delivery = "uncertain"
        if (!summary) return
        task.delivery = "uncertain"
        this.journal.add("delivery_uncertain", task.revision)
        if (!signal?.aborted && !this.stopped) {
          this.status = "Result delivery uncertain — not retried"
        }
      }
    })()
    this.notifications.add(pending)
    void pending.then(() => {
      this.notifications.delete(pending)
      this.changed?.()
    })
    return pending
  }

  private async drain() {
    if (this.draining) return
    this.draining = true
    try {
      while (this.queue.length && !this.stopped) {
        const { event, task } = this.queue.shift()!
        const controller = new AbortController()
        this.active = controller
        this.activeTask = task
        task.outcome = "awaiting_context"
        this.status = "Settling speech context"
        await new Promise<void>(resolve => {
          const done = () => {
            clearTimeout(timer)
            controller.signal.removeEventListener("abort", done)
            resolve()
          }
          // Explicit tasks do not rely on transcript finality or arrival
          // within OpenAI's settling window. Yield once for batched calls.
          const timer = setTimeout(done,
            event.task === undefined ? this.settleMs : 0)
          controller.signal.addEventListener("abort", done, { once: true })
        })
        if (controller.signal.aborted || this.stopped) {
          task.outcome = "cancelled"
          task.delivery = "not_sent"
          this.resolve(task, { outcome: "cancelled" })
          continue
        }
        this.prune()
        task.contextRevision = this.speechRevision
        let result: BackendResult
        let confirmedResult = false
        if (this.now() - task.received > this.queueMs) {
          task.outcome = "expired"
          task.delivery = "not_sent"
          this.journal.add("queue_expired", task.revision)
          this.status = "Queued request expired — please ask again"
          this.resolve(task, { outcome: "expired" })
          continue
        }
        try {
          const context = snapshot(
            this.journal.conversationId, this.owner.sessionId, event,
            this.fragments.map(f => f.event),
          )
          context.fragments.forEach((f, i) => {
            f.sequence = this.fragments[i].sequence
          })
          Object.assign(context, this.historyOwner())
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
              providerCancelled: t.providerCancelled,
              requestContext: t.context,
            }))
          // The request associated with a finding is needed to reconcile it.
          // Keep a bounded excerpt, explicitly marked as incomplete.
          const request = JSON.stringify(context.task === undefined
            ? context.fragments
            : { task: context.task, fragments: context.fragments })
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
            || Buffer.byteLength(result.summary) > MAX_RESULT_BYTES
            || !["completed", "failed", "clarification"]
              .includes(result.status)) {
            throw new Error("Invalid backend result")
          }
          confirmedResult = true
          this.journal.add("backend_completed", task.revision)
        } catch (error) {
          const missing = task.outcome !== "running"
          const reason = describeBackendFailure(error)
          if (!missing && !controller.signal.aborted) {
            console.error(`lectic live: backend task ${task.revision} failed: `
              + `${reason}; no automatic retry. `
              + "Use --keep-history for local run diagnostics.")
          }
          result = {
            status: missing ? "clarification" : "failed",
            summary: missing
              ? "Please clarify the request; no user context is available."
              : `The backend encountered an error (${reason}); `
                + "no confirmed result. Please tell the user something "
                + "went wrong. Actions may already have happened; "
                + "check actual state before retrying.",
          }
          this.journal.add(missing
            ? this.contextLost ? "context_lost" : "context_missing"
            : "backend_failed", task.revision)
        }
        if (this.stopped || controller.signal.aborted) {
          // Preserve a bounded finding for reconciliation, unless Clear or
          // context eviction removed the request it belongs to.
          if (confirmedResult && task.context) task.result = result
          task.outcome = "cancelled"
          task.delivery = "not_sent"
          this.resolve(task, { outcome: "cancelled" })
          continue
        }
        task.outcome = result.status
        task.result = result
        this.changed?.()
        this.prune()
        if (task.revision !== this.revision
          || (event.task === undefined
            && task.contextRevision !== this.speechRevision)) {
          task.delivery = "withheld"
          task.reason = task.revision !== this.revision
            ? "new_delegation" : "context_changed"
          this.journal.add("result_withheld", task.revision)
          this.status = "Result withheld: context changed. "
            + "Actions may have happened; reconcile before retrying."
          this.resolve(task, { outcome: "superseded" })
          continue
        }
        this.status = "Result sent — awaiting acknowledgment"
        task.delivery = "sent"
        this.journal.add("result_sent", task.revision)
        await this.resolve(task, {
          outcome: result.status, summary: result.summary,
        }, controller.signal)
      }
    } finally {
      this.active = undefined
      this.activeTask = undefined
      this.draining = false
      this.changed?.()
    }
  }
}
