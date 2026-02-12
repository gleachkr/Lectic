import { createWriteStream } from "fs"
import { dirname } from "path"

import { getYaml, parseLectic } from "./parsing/parse"
import { Logger } from "./logging/logger"
import { getBackend } from "./backends/util"
import {
    getScopedHooks,
    runHooksNoInline,
    type BackendUsage,
} from "./types/backend"
import { version } from "../package.json"
import { lecticEnv } from "./utils/xdg";
import { type Lectic } from "./types/lectic"
import { AssistantMessage } from "./types/message"
import { program, type OptionValues } from 'commander'
import { getIncludes, getLecticString } from "./utils/cli"

async function validateOptions(opts: OptionValues) {
    if (opts["quiet"]) {
        if (opts["short"]) {
            await Logger.write("You can't combine --short and --quiet")
            process.exit(1)
        }
        if (opts["Short"]) {
            await Logger.write("You can't combine --Short and --quiet")
            process.exit(1)
        }
    }
    if (opts["inplace"] && opts["file"]) {
        await Logger.write("You can't combine --file and --inplace")
        process.exit(1)
    }
    if (opts["version"]) {
        await Logger.write(`${version}\n`)
        process.exit(0)
    }
}

export async function generate() {

    const opts = program.opts()
    const isShort = Boolean(opts["Short"])
    const isShortLike = isShort || Boolean(opts["short"])

    let headerPrinted = false

    await validateOptions(opts)

    if (opts["log"]) Logger.logfile = opts["log"]

    if (opts["inplace"] || opts["file"]) {
        lecticEnv["LECTIC_FILE"] = opts["inplace"] || opts["file"]
    }

    const lecticString = await getLecticString(opts)

    if (opts["quiet"]) Logger.outfile = createWriteStream('/dev/null')

    if (!isShortLike) {
        await Logger.write(`${lecticString.trim()}\n\n`);
    }

    let lectic : Lectic | undefined
    let exitCode = 0
    const runId = Bun.randomUUIDv7()
    let runStartedMs = Date.now()
    let runErrorMessage: string | undefined
    let tokenTotals: BackendUsage | undefined

    const addUsage = (usage: BackendUsage) => {
        if (!tokenTotals) {
            tokenTotals = {
                input: 0,
                cached: 0,
                output: 0,
                total: 0,
            }
        }
        tokenTotals.input += usage.input
        tokenTotals.cached += usage.cached
        tokenTotals.output += usage.output
        tokenTotals.total += usage.total
    }

    try {

        const rawHeaderYaml = getYaml(lecticString)
        const docDir = lecticEnv["LECTIC_FILE"]
          ? dirname(lecticEnv["LECTIC_FILE"])
          : process.cwd()
        const includes = await getIncludes(rawHeaderYaml, docDir, docDir)

        lectic = await parseLectic(lecticString, includes)

        // expands macros in user messages, and handle directives, which may
        // update header fields
        await lectic.processMessages()

        // initialize, starting MCP servers for the active interlocutor
        await lectic.header.initialize()

        runStartedMs = Date.now()
        runHooksNoInline(getScopedHooks(lectic), "run_start", {
            RUN_ID: runId,
            RUN_STARTED_AT: new Date(runStartedMs).toISOString(),
            RUN_CWD: process.cwd(),
        })

        const backend = getBackend(lectic.header.interlocutor)
        const header = `:::${lectic.header.interlocutor.name}\n\n`
        const footer = `\n\n:::`
        lectic.body.raw = `${lectic.body.raw.trim()}\n\n` + header

        if (!isShort) {
            await Logger.write(header)
            headerPrinted = true
            const closeHeader = () => {
                // no point in updating lectic.body.raw, we're exiting.
                void Logger.write(footer)
                    .then(() => process.exit(0))
                    .catch(() => process.exit(1))
            }
            process.on('SIGTERM', closeHeader)
            process.on('SIGINT', closeHeader)
        }

        const recordingStream = (async function* () {
            for await (const chunk of backend.evaluate(lectic, {
                onAssistantPassText: (_text, info) => {
                    if (info.usage) addUsage(info.usage)
                }
            })) {
                lectic.body.raw += chunk
                yield chunk
            }
        })()

        const result = Logger.fromStream(recordingStream)
        await Logger.write(result.chunks)

        lectic.body.messages.push(new AssistantMessage({
            content: result.string,
            interlocutor: lectic.header.interlocutor,
        }))

        if (!isShort) { await Logger.write(footer) }
        lectic.body.raw += footer

        if (opts["inplace"]) {
            Logger.outfile = createWriteStream(opts["inplace"])
            await Logger.write(`${lecticString.trim()}\n\n`)
            await Logger.write(header)
            await Logger.write(result.string)
            await Logger.write(footer)
        }

        exitCode = 0
    } catch (error) {

        exitCode = 1
        if (!isShort && !headerPrinted) {
            await Logger.write(`::: Error\n\n`)
            headerPrinted = true
        }

        const ERROR_MESSAGE = error instanceof Error ? error.message : JSON.stringify(error)
        runErrorMessage = ERROR_MESSAGE
        await Logger.write(`<error>\n${ERROR_MESSAGE}\n</error>`)

        if (!isShort) await Logger.write(`\n\n:::`)
    } finally {
        if (lectic) {
            const runEndEnv: Record<string, string> = {
                RUN_ID: runId,
                RUN_STATUS: exitCode === 0 ? "success" : "error",
                RUN_DURATION_MS: String(
                    Math.max(0, Date.now() - runStartedMs)
                ),
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

            runHooksNoInline(getScopedHooks(lectic), "run_end", runEndEnv)
        }
    }

    process.exit(exitCode)
}
