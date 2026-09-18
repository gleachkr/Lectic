import { decodeEvent } from "./protocol"
import { openAIObservation } from "./openai"
import type { TranscriptObservation } from "./provider"
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
  const transcripts: TranscriptObservation[] = []
  const seen = new Set<string>()
  const results: { delegationId: string; result: BackendResult }[] = []
  for (const raw of events) {
    const decoded = decodeEvent(raw)
    const event = decoded && openAIObservation(sessionId, decoded)
    if (!event) continue
    if (event.type === "transcript") {
      transcripts.push(event)
    } else if (event.type === "request") {
      if (seen.has(event.requestId)) continue
      seen.add(event.requestId)
      const context = snapshot("offline-spike", sessionId, event, transcripts)
      results.push({
        delegationId: event.requestId,
        result: await runLectic(context, options),
      })
    }
  }
  return results
}
