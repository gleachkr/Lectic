import type { CompletionContext } from "vscode-languageserver"
import { CompletionTriggerKind } from "vscode-languageserver/node"
import * as YAML from "yaml"

import type { Macro, MacroCompletionItem } from "../types/macro"
import { isObjectRecord } from "../types/guards"
import { execCmdFull, execScriptFull } from "../utils/exec"
import { expandEnv } from "../utils/replace"

export type ResolvedMacroArgumentCompletions = {
  blockedByTriggerPolicy: boolean
  entries: MacroCompletionItem[]
}

const ERROR_LOG_WINDOW_MS = 30_000
const recentMacroCompletionErrorByKey = new Map<string, number>()

function throttleLogMacroCompletionError(key: string, message: string): void {
  const now = Date.now()
  const last = recentMacroCompletionErrorByKey.get(key)
  if (typeof last === "number" && now - last < ERROR_LOG_WINDOW_MS) return
  recentMacroCompletionErrorByKey.set(key, now)
  console.warn(`[lsp] macro completion source error (${key}): ${message}`)
}

function completionPolicy(macro: Macro): "auto" | "manual" {
  if (macro.completionTrigger === "auto" || macro.completionTrigger === "manual") {
    return macro.completionTrigger
  }

  if (typeof macro.completions === "string") {
    const trimmed = macro.completions.trimStart()
    if (trimmed.startsWith("exec:")) return "manual"
  }

  return "auto"
}

function normalizeCompletionEntries(raw: unknown): MacroCompletionItem[] {
  if (!Array.isArray(raw)) return []

  const out: MacroCompletionItem[] = []
  const seen = new Set<string>()

  for (const item of raw) {
    if (!isObjectRecord(item)) continue

    const completion = item["completion"]
    if (typeof completion !== "string") continue
    if (seen.has(completion)) continue

    const detailRaw = item["detail"]
    const documentationRaw = item["documentation"]

    const detail =
      typeof detailRaw === "string"
        ? detailRaw
        : undefined

    const documentation =
      typeof documentationRaw === "string"
        ? documentationRaw
        : undefined

    seen.add(completion)
    out.push({ completion, detail, documentation })
  }

  return out
}

function parseCompletionSourceOutput(content: string): MacroCompletionItem[] {
  const docs = YAML.parseAllDocuments(content)
  if (docs.length !== 1) {
    throw new Error(
      `expected one YAML document, got ${docs.length}`
    )
  }

  const doc = docs[0]
  if (doc.errors.length > 0) {
    throw new Error(doc.errors[0]?.message ?? "invalid YAML")
  }

  return normalizeCompletionEntries(doc.toJS())
}

async function loadMacroCompletionSource(
  source: string,
  env: Record<string, string | undefined>
): Promise<string> {
  const trimmed = source.trimStart()

  if (trimmed.startsWith("file:")) {
    const path = expandEnv(trimmed.slice(5).trim())
    if (!path) {
      throw new Error("file path cannot be empty")
    }
    return Bun.file(path).text()
  }

  if (trimmed.startsWith("exec:")) {
    const command = trimmed.slice(5).trim()
    if (!command) {
      throw new Error("exec command cannot be empty")
    }

    const result = command.includes("\n")
      ? execScriptFull(command, env)
      : execCmdFull(expandEnv(command, env), env)

    if (result.exitCode !== 0) {
      throw new Error(`command exited with code ${result.exitCode}`)
    }

    return result.stdout
  }

  throw new Error("unknown completions source prefix")
}

function filterAndSortEntries(
  entries: MacroCompletionItem[],
  prefix: string
): MacroCompletionItem[] {
  const prefixLower = prefix.toLowerCase()
  const filtered = entries.filter(entry =>
    entry.completion.toLowerCase().startsWith(prefixLower)
  )

  filtered.sort((a, b) => {
    const aExact = a.completion.startsWith(prefix) ? 0 : 1
    const bExact = b.completion.startsWith(prefix) ? 0 : 1
    if (aExact !== bExact) return aExact - bExact

    return a.completion.localeCompare(
      b.completion,
      undefined,
      { sensitivity: "base" }
    )
  })

  return filtered
}

export async function resolveMacroArgumentCompletions(
  macro: Macro,
  argPrefix: string,
  triggerContext?: CompletionContext
): Promise<ResolvedMacroArgumentCompletions> {
  const completions = macro.completions
  if (completions === undefined) {
    return { blockedByTriggerPolicy: false, entries: [] }
  }

  const policy = completionPolicy(macro)
  if (
    policy === "manual"
    && triggerContext?.triggerKind !== CompletionTriggerKind.Invoked
  ) {
    return { blockedByTriggerPolicy: true, entries: [] }
  }

  if (Array.isArray(completions)) {
    const entries = normalizeCompletionEntries(completions)
    return {
      blockedByTriggerPolicy: false,
      entries: filterAndSortEntries(entries, argPrefix),
    }
  }

  if (typeof completions !== "string") {
    return { blockedByTriggerPolicy: false, entries: [] }
  }

  const env = {
    ...macro.env,
    ARG: argPrefix,
    ARG_PREFIX: argPrefix,
    MACRO_NAME: macro.name,
    LECTIC_COMPLETION: "1",
  }

  try {
    const content = await loadMacroCompletionSource(completions, env)
    const entries = parseCompletionSourceOutput(content)
    return {
      blockedByTriggerPolicy: false,
      entries: filterAndSortEntries(entries, argPrefix),
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throttleLogMacroCompletionError(macro.name, reason)
    return { blockedByTriggerPolicy: false, entries: [] }
  }
}
