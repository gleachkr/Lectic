import { type Severity, truncateText } from "./lib"

type ToolProgressStart = {
  title: string
  message?: string
}

type ToolProgressEnd = {
  message: string
}

type ToolApproval = {
  title: string
  message: string
  allow: string
  deny: string
  severity: Severity
}

type RunProgressStart = {
  title: string
  message?: string
}

type RunProgressEnd = {
  message: string
}

const MAX_PROGRESS_MESSAGE = 160
const MAX_PROGRESS_VALUE = 56
const MAX_APPROVAL_VALUE = 180
const MAX_APPROVAL_MESSAGE = 600

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function safeJsonParse(text: string | undefined): unknown {
  if (!text || text.trim() === "") return undefined
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim()
}

function summarizeText(text: string, maxLength: number): string {
  return truncateText(normalizeWhitespace(text), maxLength) ?? ""
}

function quoteString(text: string): string {
  return JSON.stringify(text)
}

function shellQuote(text: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(text)) return text
  return quoteString(text)
}

function sortKeys(value: Record<string, unknown>): string[] {
  const priority = [
    "argv",
    "op",
    "path",
    "file",
    "script",
    "query",
    "text",
    "content",
  ]
  return Object.keys(value).sort((a, b) => {
    const ai = priority.indexOf(a)
    const bi = priority.indexOf(b)
    if (ai !== -1 || bi !== -1) {
      if (ai === -1) return 1
      if (bi === -1) return -1
      if (ai !== bi) return ai - bi
    }
    return a.localeCompare(b)
  })
}

function formatDuration(durationMs: string | undefined): string | undefined {
  if (!durationMs) return undefined
  const parsed = Number(durationMs)
  if (!Number.isFinite(parsed) || parsed < 0) return undefined
  if (parsed < 1000) {
    return `${Math.round(parsed)} ms`
  }
  if (parsed < 10_000) {
    return `${(parsed / 1000).toFixed(1)} s`
  }
  return `${Math.round(parsed / 1000)} s`
}

function appendWithLimit(
  parts: string[],
  next: string,
  maxLength: number,
  opt: { omitted: number; suffix?: string } = { omitted: 0 }
): string {
  const prefix = parts.length === 0 ? "" : " "
  const combined = parts.join(" ")
  const candidate = combined + prefix + next
  if ([...candidate].length <= maxLength) {
    parts.push(next)
    return parts.join(" ")
  }

  const hidden = opt.omitted + 1
  const suffix = opt.suffix ?? `… +${hidden} ${hidden === 1 ? "item" : "items"}`
  const base = combined.length === 0 ? "" : `${combined} `
  return truncateText(base + suffix, maxLength) ?? suffix
}

function formatArgv(argv: unknown[], maxLength: number): string | undefined {
  if (!argv.every((value) => typeof value === "string")) return undefined
  const rendered = argv.map((arg) => {
    const shortened = truncateText(arg, 40) ?? ""
    return shellQuote(shortened)
  })

  const parts: string[] = []
  for (let i = 0; i < rendered.length; i++) {
    const maybe = appendWithLimit(parts, rendered[i], maxLength, {
      omitted: rendered.length - i - 1,
      suffix: `… +${rendered.length - i} args`,
    })
    if (maybe !== parts.join(" ")) return maybe
  }

  return parts.join(" ")
}

function formatScalar(value: unknown, maxLength: number): string {
  if (typeof value === "string") {
    return quoteString(summarizeText(value, Math.max(1, maxLength - 2)))
  }
  if (
    typeof value === "number" ||
    typeof value === "boolean" ||
    value === null
  ) {
    return String(value)
  }
  if (Array.isArray(value)) {
    return value.length === 0 ? "[]" : `[${value.length} items]`
  }
  if (isRecord(value)) {
    const keys = Object.keys(value)
    return keys.length === 0 ? "{}" : `{${keys.length} keys}`
  }
  return quoteString(summarizeText(String(value), Math.max(1, maxLength - 2)))
}

function formatPairs(
  value: Record<string, unknown>,
  maxLength: number,
  valueLimit: number
): string {
  const parts: string[] = []
  const keys = sortKeys(value)

  for (let i = 0; i < keys.length; i++) {
    const key = keys[i]
    const current = value[key]
    const next = `${key}=${formatScalar(current, valueLimit)}`
    const maybe = appendWithLimit(parts, next, maxLength, {
      omitted: keys.length - i - 1,
      suffix: `… +${keys.length - i} fields`,
    })
    if (maybe !== parts.join(" ")) return maybe
  }

  return parts.join(" ")
}

function summarizeArgsForProgress(argsJson: string | undefined): string | undefined {
  const parsed = safeJsonParse(argsJson)
  if (parsed === undefined) return undefined

  if (isRecord(parsed)) {
    if (Array.isArray(parsed.argv)) {
      const argv = formatArgv(parsed.argv, MAX_PROGRESS_MESSAGE)
      if (argv) return argv
    }

    if (typeof parsed.query === "string") {
      return summarizeText(parsed.query, MAX_PROGRESS_MESSAGE)
    }

    return formatPairs(parsed, MAX_PROGRESS_MESSAGE, MAX_PROGRESS_VALUE)
  }

  if (Array.isArray(parsed)) {
    return formatScalar(parsed, MAX_PROGRESS_MESSAGE)
  }

  return summarizeText(String(parsed), MAX_PROGRESS_MESSAGE)
}

function formatApprovalArgs(toolName: string, argsJson: string | undefined): string {
  const parsed = safeJsonParse(argsJson)
  const lines = [`Tool: ${toolName}`, "", "Arguments:"]

  if (parsed === undefined) {
    lines.push("(none)")
    return lines.join("\n")
  }

  if (isRecord(parsed) && Array.isArray(parsed.argv)) {
    const argv = formatArgv(parsed.argv, MAX_APPROVAL_MESSAGE)
    if (argv) {
      lines.push(argv)
      return lines.join("\n")
    }
  }

  if (isRecord(parsed)) {
    for (const key of sortKeys(parsed)) {
      const value = parsed[key]
      if (typeof value === "string") {
        const summary = summarizeText(value, MAX_APPROVAL_VALUE)
        if (summary.includes(" ") || summary.length > 60) {
          lines.push(`- ${key}:`)
          lines.push(`  ${summary}`)
        } else {
          lines.push(`- ${key}: ${summary}`)
        }
        continue
      }

      if (Array.isArray(value) && key === "argv") {
        const argv = formatArgv(value, MAX_APPROVAL_MESSAGE)
        lines.push(`- ${key}: ${argv ?? formatScalar(value, MAX_APPROVAL_VALUE)}`)
        continue
      }

      lines.push(`- ${key}: ${formatScalar(value, MAX_APPROVAL_VALUE)}`)
    }

    return truncateText(lines.join("\n"), MAX_APPROVAL_MESSAGE)
      ?? lines.join("\n")
  }

  lines.push(formatScalar(parsed, MAX_APPROVAL_VALUE))
  return lines.join("\n")
}

function summarizeError(errorJson: string | undefined): string | undefined {
  const parsed = safeJsonParse(errorJson)
  if (isRecord(parsed) && typeof parsed.message === "string") {
    return summarizeText(parsed.message, 100)
  }
  if (parsed === undefined) return undefined
  return summarizeText(String(parsed), 100)
}

export function presentToolProgressStart(
  toolName: string,
  argsJson: string | undefined
): ToolProgressStart {
  return {
    title: `Running ${toolName}`,
    message: summarizeArgsForProgress(argsJson),
  }
}

export function presentToolProgressEnd(
  toolName: string,
  errorJson: string | undefined,
  durationMs: string | undefined
): ToolProgressEnd {
  const parts = [errorJson ? `Failed: ${toolName}` : `Done: ${toolName}`]
  const duration = formatDuration(durationMs)
  if (duration) parts.push(duration)
  const error = summarizeError(errorJson)
  if (errorJson && error) parts.push(error)
  return { message: parts.join(" · ") }
}

export function presentToolApproval(
  toolName: string,
  argsJson: string | undefined
): ToolApproval {
  return {
    title: `Allow ${toolName}?`,
    message: formatApprovalArgs(toolName, argsJson),
    allow: "Allow",
    deny: "Deny",
    severity: "warning",
  }
}

export function presentRunProgressStart(
  cwd: string | undefined
): RunProgressStart {
  return {
    title: "Lectic run",
    message: cwd ? summarizeText(cwd, MAX_PROGRESS_MESSAGE) : undefined,
  }
}

export function presentRunProgressEnd(
  status: string | undefined,
  errorMessage: string | undefined,
  durationMs: string | undefined
): RunProgressEnd {
  const success = status !== "error"
  const parts = [success ? "Run complete" : "Run failed"]
  const duration = formatDuration(durationMs)
  if (duration) parts.push(duration)
  if (!success && errorMessage) {
    parts.push(summarizeText(errorMessage, 100))
  }
  return { message: parts.join(" · ") }
}
