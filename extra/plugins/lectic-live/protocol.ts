import { record, text } from "./validation"
export { record, text } from "./validation"
import { voicePrompt } from "./prompts"

// Validated subset of the Live wire contract checked on 2026-09-14.
// Unknown event types are ignored; malformed supported events fail closed.
export const MAX_EVENT_BYTES = 64 * 1024

export function id(value: unknown): string {
  const result = text(value)
  if (!result.length || result.length > 1024) {
    throw new Error("Invalid opaque identifier")
  }
  return result
}

function time(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error("Invalid timeline value")
  }
  return value
}

export type TranscriptEvent = {
  type: "session.input_transcript.delta" | "session.output_transcript.delta"
  event_id?: string
  delta: string
  start_ms: number
  end_ms: number
}
export type DelegationEvent = {
  type: "session.delegation.created"
  event_id?: string
  offset_ms: number
  delegation: {
    id: string; type: "delegation"; target: "client" | "responses"
  }
}
export type AppendKind = "thinking" | "commentary" | "instructions"
export type LiveEvent = TranscriptEvent | DelegationEvent | {
  type: `session.${AppendKind}.appended`
  client_event_id?: string
} | {
  type: "error"
  error: { message: string; client_event_id?: string }
} | {
  type: "session.started"
  session: { id: string }
} | {
  type: "session.usage.updated"
  usage: { seconds: number }
} | {
  type: "session.closed"
  session: { id: string }
  usage: { seconds: number }
  reason: string
}

function optionalId(value: unknown): string | undefined {
  return value === undefined ? undefined : id(value)
}

export function decodeEvent(raw: string): LiveEvent | null {
  if (Buffer.byteLength(raw) > MAX_EVENT_BYTES) {
    throw new Error("Live event exceeds size limit")
  }
  const e = record(JSON.parse(raw))
  const type = text(e["type"])
  switch (type) {
    case "session.input_transcript.delta":
    case "session.output_transcript.delta": {
      const start = time(e["start_ms"])
      const end = time(e["end_ms"])
      if (end < start) throw new Error("Reversed transcript interval")
      return {
        type, event_id: optionalId(e["event_id"]),
        delta: text(e["delta"]), start_ms: start, end_ms: end,
      }
    }
    case "session.delegation.created": {
      const d = record(e["delegation"])
      if (d["type"] !== "delegation"
        || (d["target"] !== "client" && d["target"] !== "responses")) {
        throw new Error("Invalid delegation type")
      }
      return {
        type, event_id: optionalId(e["event_id"]),
        offset_ms: time(e["offset_ms"]),
        delegation: {
          id: id(d["id"]), type: "delegation", target: d["target"],
        },
      }
    }
    case "session.thinking.appended":
    case "session.commentary.appended":
    case "session.instructions.appended":
      return { type, client_event_id: optionalId(e["client_event_id"]) }
    case "error": {
      const error = record(e["error"])
      return { type, error: {
        message: text(error["message"]),
        client_event_id: optionalId(error["client_event_id"]),
      } }
    }
    case "session.started":
      return { type, session: { id: id(record(e["session"])["id"]) } }
    case "session.usage.updated":
      return { type, usage: {
        seconds: time(record(e["usage"])["seconds"]),
      } }
    case "session.closed":
      return {
        type, session: { id: id(record(e["session"])["id"]) },
        usage: { seconds: time(record(e["usage"])["seconds"]) },
        reason: text(e["reason"]),
      }
    default:
      return null
  }
}

// All browser commands go through the authenticated local controller.
// Include delegation metadata for the later bounded bootstrap handoff.
export type InitialMessage = { type: "message" } & ({
  role: "user"
  content: [{ type: "input_text"; text: string }]
} | {
  role: "assistant"
  content: [{ type: "output_text"; text: string }]
})

export function createRequest(
  sdp: string, voice?: string, input: InitialMessage[] = [],
  prompt?: string,
) {
  if (!sdp || Buffer.byteLength(sdp) > MAX_EVENT_BYTES) {
    throw new Error("Invalid SDP offer")
  }
  return {
    session: {
      instructions: prompt ? `${voicePrompt}\n\n${prompt}` : voicePrompt,
      ...(input.length ? { input } : {}),
      ...(voice ? { audio: { output: { voice } } } : {}),
      model: "gpt-live-1", delegation: { type: "client" }, store: false,
      client: { data_channel: {
        allowed_client_events: [],
        allowed_server_events: [
          "session.started", "session.closed", "session.usage.updated",
          "session.input_transcript.delta", "session.output_transcript.delta",
          "session.delegation.created", "error",
        ].map(type => ({ type })),
      } },
    },
    transport: { type: "webrtc", sdp },
  }
}

export function decodeCreated(value: unknown) {
  const v = record(value)
  const sessionId = id(record(v["session"])["id"])
  const transport = record(v["transport"])
  if (transport["type"] !== "webrtc") {
    throw new Error("Expected a WebRTC transport")
  }
  const sdp = text(transport["sdp"])
  if (!sdp.length) throw new Error("Missing SDP answer")
  return { sessionId, sdp }
}
