#!/usr/bin/env -S lectic script

import {
  approve,
  parsePositiveInteger,
  pick,
  progressBegin,
  progressEnd,
  progressReport,
  truncateText,
  type Severity,
} from "./lib"

type ParsedFlags = {
  positional: string[]
  values: Map<string, string[]>
  booleans: Set<string>
}

function usage(): string {
  return [
    "Usage:",
    "  lectic editor progress begin --token ID --title TEXT [options]",
    "  lectic editor progress report --token ID [options]",
    "  lectic editor progress end --token ID [options]",
    "  lectic editor approve --title TEXT [options]",
    "  lectic editor pick --title TEXT --option TEXT [--option TEXT ...]",
    "",
    "Commands:",
    "  progress begin   Start an LSP work-done progress item",
    "  progress report  Update an existing progress item",
    "  progress end     Finish an existing progress item",
    "  approve          Ask the editor for Allow/Deny approval",
    "  pick             Ask the editor to choose from a list",
    "",
    "Common options:",
    "  --message TEXT   Extra body text to show in the prompt",
    "  --message-max-length N",
    "                   Truncate --message to at most N characters",
    "  --severity S     error|warning|info|log (for approve/pick)",
    "  --socket PATH    Connect to an explicit socket/pipe path",
    "",
    "approve options:",
    "  --allow TEXT     Label for the allow action (default: Allow)",
    "  --deny TEXT      Label for the deny action (default: Deny)",
    "",
    "pick options:",
    "  --option TEXT    Add a selectable option (repeatable)",
    "",
    "progress options:",
    "  --percentage N   Progress percentage for begin/report",
    "",
    "Discovery:",
    "  If --socket is omitted, the command searches upward from the",
    "  active Lectic file directory (or cwd) for an active LSP bridge.",
  ].join("\n")
}

function parseFlags(args: string[]): ParsedFlags {
  const positional: string[] = []
  const values = new Map<string, string[]>()
  const booleans = new Set<string>()

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === "--help" || arg === "-h") {
      booleans.add("help")
      continue
    }

    if (!arg.startsWith("--")) {
      positional.push(arg)
      continue
    }

    const eqIndex = arg.indexOf("=")
    if (eqIndex > 0) {
      const name = arg.slice(2, eqIndex)
      const value = arg.slice(eqIndex + 1)
      const list = values.get(name) ?? []
      list.push(value)
      values.set(name, list)
      continue
    }

    const name = arg.slice(2)
    const maybeValue = args[i + 1]
    if (!maybeValue || maybeValue.startsWith("--")) {
      booleans.add(name)
      continue
    }

    const list = values.get(name) ?? []
    list.push(maybeValue)
    values.set(name, list)
    i++
  }

  return { positional, values, booleans }
}

function flagValue(parsed: ParsedFlags, name: string): string | undefined {
  const list = parsed.values.get(name)
  return list && list.length > 0 ? list[list.length - 1] : undefined
}

function flagValues(parsed: ParsedFlags, name: string): string[] {
  return parsed.values.get(name) ?? []
}

function nonEmpty(value: string | undefined, name: string): string {
  if (!value || value.trim() === "") {
    throw new Error(`${name} is required`)
  }
  return value
}

function parseSeverity(value: string | undefined): Severity | undefined {
  if (value === undefined) return undefined
  if (
    value === "error" ||
    value === "warning" ||
    value === "info" ||
    value === "log"
  ) {
    return value
  }
  throw new Error("--severity must be one of: error, warning, info, log")
}

function parsePercentage(value: string | undefined): number | undefined {
  if (value === undefined) return undefined
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) {
    throw new Error("--percentage must be a finite number")
  }
  return parsed
}

function parsedMessage(parsed: ParsedFlags): string | undefined {
  return truncateText(
    flagValue(parsed, "message"),
    parsePositiveInteger(
      flagValue(parsed, "message-max-length"),
      "--message-max-length"
    )
  )
}

async function runProgress(parsed: ParsedFlags): Promise<void> {
  const mode = parsed.positional[1]
  if (mode !== "begin" && mode !== "report" && mode !== "end") {
    throw new Error("progress requires one of: begin, report, end")
  }

  const token = nonEmpty(flagValue(parsed, "token"), "--token")
  const message = parsedMessage(parsed)
  const socket = flagValue(parsed, "socket")

  if (mode === "begin") {
    await progressBegin(
      {
        token,
        title: nonEmpty(flagValue(parsed, "title"), "--title"),
        message,
        percentage: parsePercentage(flagValue(parsed, "percentage")),
      },
      { socket }
    )
    return
  }

  if (mode === "report") {
    await progressReport(
      {
        token,
        message,
        percentage: parsePercentage(flagValue(parsed, "percentage")),
      },
      { socket }
    )
    return
  }

  await progressEnd({ token, message }, { socket })
}

async function runApprove(parsed: ParsedFlags): Promise<void> {
  const approved = await approve(
    {
      title: nonEmpty(flagValue(parsed, "title"), "--title"),
      message: parsedMessage(parsed),
      allow: flagValue(parsed, "allow"),
      deny: flagValue(parsed, "deny"),
      severity: parseSeverity(flagValue(parsed, "severity")),
    },
    { socket: flagValue(parsed, "socket") }
  )

  process.exit(approved ? 0 : 1)
}

async function runPick(parsed: ParsedFlags): Promise<void> {
  const options = flagValues(parsed, "option")
  if (options.length === 0) {
    throw new Error("pick requires at least one --option value")
  }

  const choice = await pick(
    {
      title: nonEmpty(flagValue(parsed, "title"), "--title"),
      message: parsedMessage(parsed),
      options,
      severity: parseSeverity(flagValue(parsed, "severity")),
    },
    { socket: flagValue(parsed, "socket") }
  )

  if (typeof choice === "string") {
    console.log(choice)
    process.exit(0)
  }

  process.exit(1)
}

async function main(): Promise<void> {
  const parsed = parseFlags(process.argv.slice(2))
  if (parsed.booleans.has("help") || parsed.positional.length === 0) {
    console.log(usage())
    return
  }

  const [command] = parsed.positional
  switch (command) {
    case "progress":
      await runProgress(parsed)
      return
    case "approve":
      await runApprove(parsed)
      return
    case "pick":
      await runPick(parsed)
      return
    default:
      throw new Error(`unknown command: ${command}`)
  }
}

await main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error)
  console.error(`error: ${message}`)
  console.error("")
  console.error(usage())
  process.exit(1)
})
