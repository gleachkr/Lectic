export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected an object")
  }
  return value as Record<string, unknown>
}

export function text(value: unknown): string {
  if (typeof value !== "string") throw new Error("Expected a string")
  return value
}
