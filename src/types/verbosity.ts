export const VERBOSITIES = ["low", "medium", "high"] as const

export type Verbosity = typeof VERBOSITIES[number]

export function isVerbosity(value: unknown): value is Verbosity {
  return VERBOSITIES.some((verbosity) => verbosity === value)
}

export function formatVerbosities(): string {
  const quoted = VERBOSITIES.map((verbosity) => `'${verbosity}'`)
  return `${quoted.slice(0, -1).join(", ")} or ${quoted.at(-1)}`
}
