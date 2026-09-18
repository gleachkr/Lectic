import { createHash } from "node:crypto"
import { decodeEvent, type LiveEvent } from "./protocol"
import type { Connect } from "./session"
import {
  Lifecycle, sameOwner, type CloseState, type Complete, type Owner,
  type ProviderConnect, type ProviderObservation,
} from "./provider"
import type { LiveClient } from "./live-client"

// Keep the established OpenAI bootstrap/sideband deduplication policy here.
// Gemini normal fragments have no such identity; equal words are not copies.
export function openAIObservation(
  sessionId: string, event: LiveEvent,
): ProviderObservation | null {
  const owner: Owner = {
    provider: "openai", sessionId, sessionIdSource: "provider",
  }
  const identity = "event_id" in event && event.event_id
    ? `id:${event.event_id}`
    : createHash("sha256").update(JSON.stringify(event)).digest("hex")
  const base = { owner, identity }
  switch (event.type) {
    case "session.input_transcript.delta":
    case "session.output_transcript.delta":
      return { ...base, type: "transcript",
        speaker: event.type === "session.input_transcript.delta"
          ? "user" : "assistant",
        text: event.delta, eventId: event.event_id,
        media: { startMs: event.start_ms, endMs: event.end_ms } }
    case "session.delegation.created":
      return event.delegation.target === "client"
        ? { ...base, type: "request", requestId: event.delegation.id,
          offsetMs: event.offset_ms } : null
    case "session.started":
    case "session.closed":
      if (event.session.id !== sessionId) {
        throw new Error("Wrong session ownership")
      }
      return event.type === "session.started"
        ? { ...base, type: "started" }
        : { ...base, type: "usage", unit: "seconds",
          completeness: "final", seconds: event.usage.seconds }
    case "session.usage.updated":
      return { ...base, type: "usage", unit: "seconds",
        completeness: "partial", seconds: event.usage.seconds }
    case "error": return { ...base, type: "error" }
    default: return null
  }
}

export function openAIComplete(owner: Owner, client: LiveClient): Complete {
  return async completion => {
    if (!sameOwner(owner, completion.owner)) {
      throw new Error("Wrong completion owner")
    }
    // OpenAI's existing behavior has no wire response for these outcomes.
    if (!("summary" in completion)) {
      return { transmission: "not_sent", acknowledgment: "unavailable" }
    }
    const summary = completion.summary
    if (Buffer.byteLength(summary) <= 400) {
      await client.append("commentary", completion.requestId, summary)
    } else {
      // Leave room for numbering within the 400-byte/500-token wire bound.
      // Iterate code points, never split a UTF-8 sequence. Send once, in
      // order; an uncertain part stops delivery without replaying it.
      const parts: string[] = []
      let part = ""
      let bytes = 0
      for (const character of summary) {
        const size = Buffer.byteLength(character)
        if (bytes + size > 340) {
          parts.push(part)
          part = ""
          bytes = 0
        }
        part += character
        bytes += size
      }
      if (part) parts.push(part)
      for (const [index, content] of parts.entries()) {
        await client.append("commentary", completion.requestId,
          `Backend result part ${index + 1}/${parts.length}:\n${content}`)
      }
    }
    return { transmission: "sent", acknowledgment: "acknowledged" }
  }
}

export function openAIProvider(connect: Connect): ProviderConnect {
  return async (sdp, receive, lost, signal, history) => {
    const lifecycle = new Lifecycle()
    let sessionId: string | undefined = undefined
    const buffered: LiveEvent[] = []
    const observe = (event: LiveEvent): ProviderObservation[] => {
      const observation = openAIObservation(sessionId!, event)
      if (!observation) return []
      if (observation.type === "usage") {
        lifecycle.observe({ transport: "open",
          remote: event.type === "session.closed" ? "ended" : "unknown",
          usage: observation.completeness })
      }
      return event.type === "session.closed"
        ? [observation, { owner: observation.owner, type: "lifecycle",
          state: lifecycle.snapshot() }] : [observation]
    }
    const connection = await connect(sdp, event => {
      if (!sessionId) buffered.push(event)
      else for (const observation of observe(event)) receive(observation)
      if (buffered.length > 256) throw new Error("Bootstrap overflow")
    }, lost, signal, history)
    sessionId = connection.id
    const owner: Owner = {
      provider: "openai", sessionId, sessionIdSource: "provider",
    }
    for (const event of buffered) {
      for (const observation of observe(event)) receive(observation)
    }
    return {
      owner, media: { kind: "webrtc", sdp: connection.sdp },
      complete: openAIComplete(owner, connection.client),
      async close(): Promise<CloseState> {
        const confirmed = await connection.close()
        lifecycle.observe({ transport: "closed",
          remote: confirmed ? "ended" : "unknown",
          usage: confirmed ? "final" : "unknown" })
        return lifecycle.snapshot()
      },
      bootstrap(raw) {
        const events = raw.map(decodeEvent).filter(e => e !== null)
        if (!events.some(e => e.type === "session.started"
          && e.session.id === sessionId)) {
          throw new Error("Missing session.started")
        }
        return events.flatMap(observe)
      },
    }
  }
}
