import { decodeEvent, type TranscriptEvent } from "./protocol"
import { snapshot } from "./transcript"
import { runLectic, type RunOptions } from "./lectic-runner"
import type { BackendResult } from "./result"

// Offline, finite replay harness, not the live scheduler. Each delegation
// consumes only preceding fragments. Settling/revisions belong to stage 2/3.
export async function replaySpike(
  events: string[],
  sessionId: string,
  options: RunOptions,
): Promise<{ delegationId: string; result: BackendResult }[]> {
  if (events.length > 256) throw new Error("Spike event limit exceeded")
  const transcripts: TranscriptEvent[] = []
  const seen = new Set<string>()
  const results: { delegationId: string; result: BackendResult }[] = []
  for (const raw of events) {
    const event = decodeEvent(raw)
    if (!event) continue
    if (event.type === "session.input_transcript.delta"
      || event.type === "session.output_transcript.delta") {
      transcripts.push(event)
    } else if (event.type === "session.delegation.created"
      && event.delegation.target === "client") {
      if (seen.has(event.delegation.id)) continue
      seen.add(event.delegation.id)
      const context = snapshot("offline-spike", sessionId, event, transcripts)
      results.push({
        delegationId: event.delegation.id,
        result: await runLectic(context, options),
      })
    }
  }
  return results
}
