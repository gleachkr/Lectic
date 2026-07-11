import type { ServiceTier } from "../types/serviceTier"

export type OpenAIServiceTier =
  | "auto"
  | "default"
  | "flex"
  | "priority"

export function openAIServiceTier(
  tier: ServiceTier | undefined,
): OpenAIServiceTier | undefined {
  return tier === "standard" ? "default" : tier
}

export type CodexServiceTier = "default" | "flex" | "priority"

export function codexServiceTier(
  tier: ServiceTier | undefined,
): CodexServiceTier | undefined {
  if (tier === "auto" || tier === undefined) return undefined
  return tier === "standard" ? "default" : tier
}

export type AnthropicServiceTier = "auto" | "standard_only"

export function anthropicServiceTier(
  tier: ServiceTier | undefined,
): AnthropicServiceTier | undefined {
  switch (tier) {
    case undefined:
      return undefined
    case "auto":
    case "priority":
      return "auto"
    case "default":
    case "standard":
      return "standard_only"
    case "flex":
      return undefined
  }
}
