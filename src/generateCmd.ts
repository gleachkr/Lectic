import { createWriteStream } from "fs"
import { dirname } from "path"

import { program, type OptionValues } from "commander"

import { version } from "../package.json"
import { getBackend } from "./backends/util"
import { Logger } from "./logging/logger"
import { getYaml, parseLectic } from "./parsing/parse"
import { type Lectic } from "./types/lectic"
import { AssistantMessage } from "./types/message"
import {
  getScopedHooks,
  runHooksNoInline,
  type BackendUsage,
} from "./types/backend"
import {
  getIncludes,
  getLecticString,
} from "./utils/cli"
import { lecticEnv } from "./utils/xdg"

const OUTPUT_FORMATS = ["full", "block", "raw", "clean", "none"] as const

type OutputFormat = (typeof OUTPUT_FORMATS)[number]

function isOutputFormat(value: string): value is OutputFormat {
  return OUTPUT_FORMATS.includes(value as OutputFormat)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : JSON.stringify(error)
}

async function failAndExit(message: string): Promise<never> {
  await Logger.write(message)
  process.exit(1)
}

async function resolveOutputFormat(opts: OptionValues): Promise<OutputFormat> {
  const hasFormat = opts["format"] !== undefined
  const hasShort = Boolean(opts["short"])
  const hasRawShort = Boolean(opts["Short"])
  const hasQuiet = Boolean(opts["quiet"])
  const hasLegacy = hasShort || hasRawShort || hasQuiet

  if (hasFormat && hasLegacy) {
    await failAndExit(
      "You can't combine --format with --short, --Short, or --quiet"
    )
  }

  if (hasFormat) {
    const normalized = String(opts["format"]).toLowerCase()
    if (!isOutputFormat(normalized)) {
      await failAndExit(
        `Unsupported --format value: ${normalized}. ` +
        `Use one of: ${OUTPUT_FORMATS.join(", ")}`
      )
    } else {
        return normalized
    }
  }

  if (hasShort && hasRawShort) {
    await failAndExit("You can't combine --short and --Short")
  }

  if (hasQuiet && hasShort) {
    await failAndExit("You can't combine --short and --quiet")
  }

  if (hasQuiet && hasRawShort) {
    await failAndExit("You can't combine --Short and --quiet")
  }

  if (hasQuiet) return "none"
  if (hasRawShort) return "raw"
  if (hasShort) return "block"
  return "full"
}

async function validateOptions(
  opts: OptionValues
): Promise<OutputFormat> {

  if (opts["inplace"] && !opts["file"]) {
    await failAndExit("You can't use --inplace without --file")
  }

  if (opts["version"]) {
    await Logger.write(`${version}\n`)
    process.exit(0)
  }

  return resolveOutputFormat(opts)
}

function addUsage(
  totals: BackendUsage | undefined,
  usage: BackendUsage | undefined
): BackendUsage | undefined {
  if (!usage) return totals

  const next = totals ?? {
    input: 0,
    cached: 0,
    output: 0,
    total: 0,
  }

  next.input += usage.input
  next.cached += usage.cached
  next.output += usage.output
  next.total += usage.total
  return next
}

async function parseAndInitializeLectic(lecticString: string): Promise<Lectic> {
  const rawHeaderYaml = getYaml(lecticString)
  const docDir = lecticEnv["LECTIC_FILE"]
    ? dirname(lecticEnv["LECTIC_FILE"])
    : process.cwd()

  const includes = await getIncludes(rawHeaderYaml, docDir, docDir)
  const lectic = await parseLectic(lecticString, includes)

  await lectic.processMessages()
  await lectic.header.initialize()

  return lectic
}

export async function generate() {
  const opts = program.opts()
  const format = await validateOptions(opts)

  const showBlock = format === "full" || format === "block"
  const showRaw = showBlock || format === "raw"
  const showClean = format === "clean"
  const showErrors = format !== "none"

  if (opts["log"]) Logger.logfile = opts["log"]

  lecticEnv["LECTIC_FILE"] = opts["file"]

  if (format === "none") Logger.outfile = createWriteStream("/dev/null")

  const lecticString = await getLecticString(opts)

  if (format === "full") await Logger.write(`${lecticString.trim()}\n\n`)

  let lectic: Lectic | undefined
  let exitCode = 0
  let headerPrinted = false

  const runId = Bun.randomUUIDv7()
  const runStartedMs = Date.now()
  let runErrorMessage: string | undefined
  let tokenTotals: BackendUsage | undefined

  try {
    lectic = await parseAndInitializeLectic(lecticString)

    runHooksNoInline(getScopedHooks(lectic), "run_start", {
      RUN_ID: runId,
      RUN_STARTED_AT: new Date(runStartedMs).toISOString(),
      RUN_CWD: process.cwd(),
    })

    const backend = getBackend(lectic.header.interlocutor)
    const header = `:::${lectic.header.interlocutor.name}\n\n`
    const footer = `:::`

    lectic.body.raw = `${lectic.body.raw.trim()}\n\n${header}`

    if (showBlock) {
      await Logger.write(header)
      headerPrinted = true

      const closeHeader = () => {
        void Logger.write(footer)
          .then(() => process.exit(0))
          .catch(() => process.exit(1))
      }
      process.on("SIGTERM", closeHeader)
      process.on("SIGINT", closeHeader)
    }

    let assistantRaw = ""
    let cleanNeedsSeparator = false

    for await (const chunk of backend.evaluate(lectic, {
      onAssistantPassText: (text, info) => {
        tokenTotals = addUsage(tokenTotals, info.usage)

        if (showClean && info.hasToolCalls && text.trim().length > 0) {
          cleanNeedsSeparator = true
        }
      },
      onAssistantTextDelta: async (text) => {
        if (!showClean) return

        if (cleanNeedsSeparator) {
          await Logger.write("\n\n")
          cleanNeedsSeparator = false
        }

        await Logger.write(text)
      },
    })) {
      lectic.body.raw += chunk
      assistantRaw += chunk

      if (showRaw) await Logger.write(chunk)
    }

    lectic.body.messages.push(new AssistantMessage({
      content: assistantRaw,
      interlocutor: lectic.header.interlocutor,
    }))

    if (showBlock) await Logger.write(footer)
    lectic.body.raw += footer

    if (opts["inplace"] && opts["file"]) {
      Logger.outfile = createWriteStream(opts["file"])
      await Logger.write(`${lecticString.trim()}\n\n`)
      await Logger.write(header)
      await Logger.write(assistantRaw)
      await Logger.write(footer)
    }

    exitCode = 0
  } catch (error) {
    exitCode = 1
    runErrorMessage = errorMessage(error)

    if (showErrors) {
      if (showBlock && !headerPrinted) {
        await Logger.write("::: Error\n\n")
        headerPrinted = true
      }

      await Logger.write(`<error>\n${runErrorMessage}\n</error>`)

      if (showBlock) await Logger.write("\n\n:::")
    }
  } finally {
    if (lectic) {
      const runEndEnv: Record<string, string> = {
        RUN_ID: runId,
        RUN_STATUS: exitCode === 0 ? "success" : "error",
        RUN_DURATION_MS: String(Math.max(0, Date.now() - runStartedMs)),
      }

      if (runErrorMessage) {
        runEndEnv["RUN_ERROR_MESSAGE"] = runErrorMessage
        runEndEnv["ERROR_MESSAGE"] = runErrorMessage
      }

      if (tokenTotals) {
        runEndEnv["TOKEN_USAGE_INPUT"] = String(tokenTotals.input)
        runEndEnv["TOKEN_USAGE_CACHED"] = String(tokenTotals.cached)
        runEndEnv["TOKEN_USAGE_OUTPUT"] = String(tokenTotals.output)
        runEndEnv["TOKEN_USAGE_TOTAL"] = String(tokenTotals.total)
      }

      try {
        runHooksNoInline(getScopedHooks(lectic), "run_end", runEndEnv)
      } catch (error) {
        exitCode = 1
        const message = errorMessage(error)
        await Logger.write(`\n<hook-error>\n${message}\n</hook-error>`)
      }
    }
  }

  process.exit(exitCode)
}
