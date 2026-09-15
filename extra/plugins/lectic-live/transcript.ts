import type { DelegationEvent, TranscriptEvent } from "./protocol"
import type { Delivery, Task } from "./state"
import type { HistoryContext } from "./history"

export type ContextEnvelope = {
  version: 1
  conversationId: string
  sessionId: string
  delegationId: string
  offsetMs: number
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
    delivery?: Delivery
    reason?: Task["reason"]
    requestContext?: string
  }[]
  fragments: {
    speaker: "user" | "assistant"
    text: string
    startMs: number
    endMs: number
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
  delegation: DelegationEvent,
  transcripts: TranscriptEvent[],
): ContextEnvelope {
  if (transcripts.length > 256) throw new Error("Too many fragments")
  if (!transcripts.some(e =>
    e.type === "session.input_transcript.delta" && e.delta.trim())) {
    throw new Error("Insufficient context; ask for clarification")
  }
  return {
    version: 1, conversationId, sessionId,
    delegationId: delegation.delegation.id,
    offsetMs: delegation.offset_ms,
    fragments: transcripts.map((e, sequence) => ({
      speaker: e.type === "session.input_transcript.delta"
        ? "user" : "assistant",
      text: e.delta, startMs: e.start_ms, endMs: e.end_ms,
      sequence, eventId: e.event_id,
    })),
  }
}
