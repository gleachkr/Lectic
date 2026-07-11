export const SERVICE_TIERS = [
  "auto",
  "default",
  "standard",
  "flex",
  "priority",
] as const

export type ServiceTier = typeof SERVICE_TIERS[number]

export function isServiceTier(value: unknown): value is ServiceTier {
  return SERVICE_TIERS.some((tier) => tier === value)
}

export function formatServiceTiers(): string {
  const quoted = SERVICE_TIERS.map((tier) => `'${tier}'`)
  return `${quoted.slice(0, -1).join(", ")} or ${quoted.at(-1)}`
}
