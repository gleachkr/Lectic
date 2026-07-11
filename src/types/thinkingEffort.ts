export const THINKING_EFFORTS = [
  "none",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const

export type ThinkingEffort = typeof THINKING_EFFORTS[number]

export function isThinkingEffort(value: unknown): value is ThinkingEffort {
  return THINKING_EFFORTS.some((effort) => effort === value)
}

export function formatThinkingEfforts(): string {
  const quoted = THINKING_EFFORTS.map((effort) => `'${effort}'`)
  return `${quoted.slice(0, -1).join(", ")} or ${quoted.at(-1)}`
}
