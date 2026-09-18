import { MAX_RESULT_BYTES } from "./result"

export class GeminiWireError extends Error {}

// Provider validation, deliberately separate from local browser controls.
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new GeminiWireError("Invalid object")
  }
  return value as Record<string, unknown>
}
export function string(value: unknown, max: number): string {
  if (typeof value !== "string" || Buffer.byteLength(value) > max) {
    throw new GeminiWireError("Invalid string")
  }
  return value
}
function list(value: unknown, max: number): unknown[] {
  if (!Array.isArray(value) || value["length"] > max) {
    throw new GeminiWireError("Invalid array")
  }
  return value
}
function id(value: unknown) {
  const result = string(value, 256)
  if (!result.trim()) throw new GeminiWireError("Empty ID")
  return result
}
export type Call = { id: string; task: string }
export type Observation =
  | { type: "setup" | "interrupted" | "generationComplete"
    | "turnComplete" | "goAway" }
  | { type: "turnReason"; reason: string }
  | { type: "audio"; pcm: Buffer }
  | { type: "input" | "output"; text: string }
  | { type: "call"; call: Call }
  | { type: "cancel"; id: string }
  | { type: "usage"; counters: Record<string, number> }

export function decode(raw: string): Observation[] {
  if (Buffer.byteLength(raw) > 512 * 1024) {
    throw new GeminiWireError("Provider message limit")
  }
  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch {
    throw new GeminiWireError("Invalid JSON")
  }
  const value = object(parsed)
  const kinds = ["setupComplete", "serverContent", "toolCall",
    "toolCallCancellation", "goAway", "sessionResumptionUpdate"]
  if (kinds.filter(key => key in value).length > 1 || "error" in value) {
    throw new GeminiWireError("Invalid provider envelope")
  }
  const events: Observation[] = []
  if ("setupComplete" in value) {
    object(value["setupComplete"])
    events.push({ type: "setup" })
  }
  if ("serverContent" in value) {
    const content = object(value["serverContent"])
    if ("turnCompleteReason" in content) {
      const reason = string(content["turnCompleteReason"], 256)
      // SDK 2.10.0 TurnCompleteReason enum; never reflect unknown strings.
      const known = [
        "TURN_COMPLETE_REASON_UNSPECIFIED",
        "MALFORMED_FUNCTION_CALL",
        "RESPONSE_REJECTED",
        "NEED_MORE_INPUT",
        "PROHIBITED_INPUT_CONTENT",
        "IMAGE_PROHIBITED_INPUT_CONTENT",
        "INPUT_TEXT_CONTAIN_PROMINENT_PERSON_PROHIBITED",
        "INPUT_IMAGE_CELEBRITY",
        "INPUT_IMAGE_PHOTO_REALISTIC_CHILD_PROHIBITED",
        "INPUT_TEXT_NCII_PROHIBITED",
        "INPUT_OTHER",
        "INPUT_IP_PROHIBITED",
        "BLOCKLIST",
        "UNSAFE_PROMPT_FOR_IMAGE_GENERATION",
        "GENERATED_IMAGE_SAFETY",
        "GENERATED_CONTENT_SAFETY",
        "GENERATED_AUDIO_SAFETY",
        "GENERATED_VIDEO_SAFETY",
        "GENERATED_CONTENT_PROHIBITED",
        "GENERATED_CONTENT_BLOCKLIST",
        "GENERATED_IMAGE_PROHIBITED",
        "GENERATED_IMAGE_CELEBRITY",
        "GENERATED_IMAGE_PROMINENT_PEOPLE_DETECTED_BY_REWRITER",
        "GENERATED_IMAGE_IDENTIFIABLE_PEOPLE",
        "GENERATED_IMAGE_MINORS",
        "OUTPUT_IMAGE_IP_PROHIBITED",
        "GENERATED_OTHER",
        "MAX_REGENERATION_REACHED",
      ]
      events.push({ type: "turnReason",
        reason: known.includes(reason) ? reason : "OTHER_TURN_REASON" })
    }
    // Flush before handling audio, regardless of JSON field order.
    for (const type of ["interrupted", "generationComplete",
      "turnComplete"] as const) {
      if (type in content) {
        if (typeof content[type] !== "boolean") {
          throw new GeminiWireError("Invalid content flag")
        }
        if (content[type]) events.push({ type })
      }
    }
    for (const [key, type] of [
      ["inputTranscription", "input"],
      ["outputTranscription", "output"],
    ] as const) {
      if (key in content) {
        const transcript = object(content[key])
        if ("text" in transcript) {
          events.push({ type, text: string(transcript["text"], 8192) })
        }
      }
    }
    if ("modelTurn" in content) {
      const turn = object(content["modelTurn"])
      for (const part of list(turn["parts"], 32)) {
        const item = object(part)
        if (!("inlineData" in item)) continue
        const data = object(item["inlineData"])
        if (data["mimeType"] !== "audio/pcm;rate=24000") {
          throw new GeminiWireError("Invalid audio MIME")
        }
        const base64 = string(data["data"], 256000)
        if (!base64 || base64.length % 4
          || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) {
          throw new GeminiWireError("Invalid base64")
        }
        const pcm = Buffer.from(base64, "base64")
        if (!pcm.length || pcm.length % 2 || pcm.length > 192000
          || pcm.toString("base64") !== base64) {
          throw new GeminiWireError("Invalid PCM")
        }
        if (!content["interrupted"]) events.push({ type: "audio", pcm })
      }
    }
  }
  if ("toolCall" in value) {
    for (const entry of list(object(value["toolCall"])["functionCalls"], 8)) {
      const call = object(entry)
      if (call["name"] !== "delegate") {
        throw new GeminiWireError("Unknown function")
      }
      const args = object(call["args"])
      const task = string(args["task"], 4096)
      if (!task.trim() || Object.keys(args).join() !== "task") {
        throw new GeminiWireError("Invalid task")
      }
      events.push({ type: "call", call: { id: id(call["id"]), task } })
    }
  }
  if ("toolCallCancellation" in value) {
    const ids = object(value["toolCallCancellation"])["ids"]
    for (const entry of list(ids, 32)) {
      events.push({ type: "cancel", id: id(entry) })
    }
  }
  if ("goAway" in value) {
    const go = object(value["goAway"])
    if ("timeLeft" in go
      && !/^\d+(\.\d{1,9})?s$/.test(string(go["timeLeft"], 32))) {
      throw new GeminiWireError("Invalid duration")
    }
    events.push({ type: "goAway" })
  }
  if ("usageMetadata" in value) {
    const usage = object(value["usageMetadata"])
    const counters: Record<string, number> = {}
    for (const key of ["promptTokenCount", "responseTokenCount",
      "totalTokenCount", "cachedContentTokenCount", "thoughtsTokenCount",
      "toolUsePromptTokenCount"]) {
      if (!(key in usage)) continue
      const count = usage[key]
      if (typeof count !== "number" || !Number.isSafeInteger(count)
        || count < 0) throw new GeminiWireError("Invalid usage")
      counters[key] = count
    }
    events.push({ type: "usage", counters })
  }
  // Preserve accompanying usage even when GoAway terminates processing.
  return [
    ...events.filter(event => event.type !== "goAway"),
    ...events.filter(event => event.type === "goAway"),
  ]
}

export function toolResult(callId: string, result: string) {
  id(callId)
  // Allow the shared summary plus its adapter-owned outcome prefix.
  if (!string(result, MAX_RESULT_BYTES + 32).trim()) {
    throw new GeminiWireError("Empty result")
  }
  return { toolResponse: { functionResponses: [{
    id: callId, name: "delegate", response: { result },
    scheduling: "WHEN_IDLE", willContinue: false,
  }] } }
}
