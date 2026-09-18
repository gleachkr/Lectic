import { boundHistory, historyLimit, type HistoryContext } from "./history"
import type { InitialMessage } from "./protocol"

// History remains data, never developer instructions or an execution queue.
// Exact deltas concatenate only across adjacent fragments of one speaker.
export function voiceHistory(context?: HistoryContext): InitialMessage[] {
  if (!context) return []
  const messages: InitialMessage[] = []
  for (const f of boundHistory(context).fragments) {
    if (f.speaker !== "user" && f.speaker !== "assistant") continue
    const last = messages.at(-1)
    if (last?.role === f.speaker) last.content[0].text += f.text
    else messages.push(f.speaker === "user"
      ? { type: "message", role: "user",
        content: [{ type: "input_text", text: f.text }] }
      : { type: "message", role: "assistant",
        content: [{ type: "output_text", text: f.text }] })
  }
  // The byte bound is conservative for the API's 8,192-token input limit.
  const result = messages.filter(m => m.content[0].text.trim())
  while (result.length > 128
    || Buffer.byteLength(JSON.stringify(result)) > historyLimit) {
    result.shift()
  }
  return result
}
