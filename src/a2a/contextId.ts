export const A2A_CONTEXT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

export function isValidA2AContextId(id: string): boolean {
  return A2A_CONTEXT_ID_RE.test(id)
}

export function resolveA2AContextId(input?: string | null): string {
  if (input == null) {
    return crypto.randomUUID()
  }

  if (!isValidA2AContextId(input)) {
    throw new Error(
      `Invalid contextId ${JSON.stringify(input)}. Expected pattern ` +
        `${A2A_CONTEXT_ID_RE}`
    )
  }

  return input
}
