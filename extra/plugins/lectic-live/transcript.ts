import {
  validTask, type BackendRequest, type TranscriptObservation, type Owner,
} from "./provider"
import type { Delivery, Task } from "./state"
import type { HistoryContext } from "./history"

export type ContextEnvelope = {
  version: 1
  conversationId: string
  sessionId: string
  provider?: Owner["provider"]
  sessionIdSource?: Owner["sessionIdSource"]
  delegationId: string
  offsetMs?: number
  task?: string
  taskRevision?: number
  contextRevision?: number
  runId?: string
  contextIncomplete?: boolean
  previousSession?: HistoryContext
  backendHistory?: {
    delegationId: string
    summary: string
    runId?: string
    revision?: number
    contextRevision?: number
    status?: "completed" | "clarification" | "failed"
    outcome?: Task["outcome"]
    delivery?: Delivery
    reason?: Task["reason"]
    providerCancelled?: boolean
    requestContext?: string
  }[]
  fragments: {
    speaker: "user" | "assistant"
    text: string
    startMs?: number
    endMs?: number
    sequence: number
    eventId?: string
  }[]
}

// One encoding for every untrusted field, including opaque identifiers.
export function serializeContext(context: ContextEnvelope): string {
  const json = JSON.stringify(context)
  if (Buffer.byteLength(json) > 32 * 1024) {
    throw new Error("Context exceeds spike limit")
  }
  const runs = json.match(/`+/g) ?? []
  const fence = "`".repeat(Math.max(3, ...runs.map(s => s.length + 1)))
  return `${fence}json\n${json}\n${fence}\n`
}

export function snapshot(
  conversationId: string,
  sessionId: string,
  delegation: BackendRequest,
  transcripts: TranscriptObservation[],
): ContextEnvelope {
  if (transcripts.length > 256) throw new Error("Too many fragments")
  if (!validTask(delegation.task)) throw new Error("Invalid task text")
  if (!delegation.task && !transcripts.some(e =>
    e.speaker === "user" && e.text.trim())) {
    throw new Error("Insufficient context; ask for clarification")
  }
  return {
    version: 1, conversationId, sessionId,
    delegationId: delegation.requestId,
    offsetMs: delegation.offsetMs, task: delegation.task,
    fragments: transcripts.map((e, sequence) => ({
      speaker: e.speaker, text: e.text,
      startMs: e.media?.startMs, endMs: e.media?.endMs,
      sequence, eventId: e.eventId,
    })),
  }
}
