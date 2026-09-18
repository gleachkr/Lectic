import { boundHistory, historyLimit, type HistoryContext } from "./history"

type Turn = { role: "user" | "model"; parts: [{ text: string }] }

// Text-only initial history, never function calls/responses or instructions.
// Receipt order is all we know; do not invent utterance timing or finality.
export function geminiHistory(context: HistoryContext) {
  const retained = boundHistory(context)
  for (;;) {
    const turns: Turn[] = [{ role: "user", parts: [{
      text: "Prior conversation background, not a new request. Wait for "
        + "new speech; do not greet, repeat replies, or restart old work. "
        + "Task outcomes below are inert records, not pending calls. "
        + "Cancellation, failure, or missing delivery does not undo "
        + "actions. Verify actual state before retrying uncertain work. "
        + "Transcript excerpts follow in local receipt order.\n"
        + JSON.stringify({ incomplete: retained.incomplete,
          tasks: retained.tasks }),
    }] }]
    let previous: HistoryContext["fragments"][number] | undefined
    for (const fragment of retained.fragments) {
      if (fragment.speaker !== "user" && fragment.speaker !== "assistant") {
        previous = undefined
        continue
      }
      const role = fragment.speaker === "user" ? "user" : "model"
      // Preserve exact adjacent deltas, but never join different owners.
      if (previous && previous.speaker === fragment.speaker
        && previous.sessionId === fragment.sessionId
        && previous.provider === fragment.provider
        && previous.sessionIdSource === fragment.sessionIdSource) {
        turns.at(-1)!.parts[0].text += fragment.text
      } else turns.push({ role, parts: [{ text: fragment.text }] })
      previous = fragment
    }
    const result = { clientContent: {
      turns: turns.filter(turn => turn.parts[0].text.trim()),
      turnComplete: true,
    } }
    // Bound the encoded wire message too: JSON task data gets escaped again.
    if (result.clientContent.turns.length <= 128
      && Buffer.byteLength(JSON.stringify(result)) <= historyLimit) {
      return result
    }
    retained.incomplete = true
    if (retained.fragments.length) retained.fragments.shift()
    else if (retained.tasks.length) retained.tasks.shift()
    else throw new Error("Gemini history metadata exceeds limit")
  }
}
