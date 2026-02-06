export const INTERLOCUTOR_KEYS = [
  "name",
  "prompt",
  "provider",
  "model",
  "temperature",
  "max_tokens",
  "max_tool_use",
  "thinking_effort",
  "thinking_budget",
  "tools",
  "nocache",
  "hooks",
  "sandbox",
  "output_schema",
  "a2a",
] as const

export type InterlocutorKey = typeof INTERLOCUTOR_KEYS[number]

export const INTERLOCUTOR_KEY_SET = new Set<string>(INTERLOCUTOR_KEYS)
