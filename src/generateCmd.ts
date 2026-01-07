import { createWriteStream } from "fs"
import { parseLectic } from "./parsing/parse"
import { Logger } from "./logging/logger"
import { getBackend } from "./backends/util"
import { runHooks } from "./types/backend"
import { version } from "../package.json"
import { lecticEnv } from "./utils/xdg";
import { Lectic } from "./types/lectic"
import { program, type OptionValues } from 'commander'
import { getIncludes, getLecticString } from "./utils/cli"

function validateOptions(opts : OptionValues) {
    if (opts["quiet"]) {
        if (opts["short"]) {
            Logger.write("You can't combine --short and --quiet");
            process.exit(1)
        }
        if (opts["Short"]) {
            Logger.write("You can't combine --Short and --quiet");
            process.exit(1)
        }
    }
    if (opts["inplace"] && opts["file"]) {
        Logger.write("You can't combine --file and --inplace");
        process.exit(1)
    }
    if (opts["version"]) {
        Logger.write(`${version}\n`) 
        process.exit(0)
    }
}

export async function generate() {

    const opts = program.opts()

    let headerPrinted = false

    validateOptions(opts)

    if (opts["log"]) Logger.logfile = opts["log"]

    if (opts["inplace"] || opts["file"]) {
        lecticEnv["LECTIC_FILE"] = opts["inplace"] || opts["file"]
    }

    const lecticString = await getLecticString(opts)

    if (opts["quiet"]) Logger.outfile = createWriteStream('/dev/null')

    if (!(opts["Short"] || opts["short"])) {
        await Logger.write(`${lecticString.trim()}\n\n`);
    }

    let lectic : Lectic | undefined

    try {

        const includes = await getIncludes()

        lectic = await parseLectic(lecticString, includes)

        // expands macros in user messages, and handle directives, which may
        // update header fields
        await lectic.processMessages()

        // initialize, starting MCP servers for the active interlocutor
        await lectic.header.initialize()

        const backend = getBackend(lectic.header.interlocutor)
        const header = `:::${lectic.header.interlocutor.name}\n\n`
        const footer = `\n\n:::`
        lectic.body.raw = `${lectic.body.raw.trim()}\n\n` + header

        if (!program.opts()["Short"]) {
            await Logger.write(header)
            headerPrinted = true
            const closeHeader = () => { 
                // no point in updating lectic.body.raw, we're exiting.
                Logger.write(footer).then(() => process.exit(0)) 
            }
            process.on('SIGTERM', closeHeader)
            process.on('SIGINT', closeHeader)
        }

        const recordingStream = (async function* () {
            for await (const chunk of backend.evaluate(lectic)) {
                // Only append text strings to the raw body, ignore non-string return values
                if (typeof chunk === 'string') {
                    lectic.body.raw += chunk
                }
                yield chunk
            }
        })()

        const result = Logger.fromStream(recordingStream)
        await Logger.write(result.chunks)
        await result.rest

        if (!program.opts()["Short"]) { await Logger.write(footer) }
        if (lectic) lectic.body.raw += footer

        if (opts["inplace"]) {
            Logger.outfile = createWriteStream(opts["inplace"])
            await Logger.write(`${lecticString.trim()}\n\n`)
            await Logger.write(header)
            await result.string.then(string => Logger.write(string))
            await Logger.write(footer)
        }
        process.exit(0)
    } catch (error) {

        if (!program.opts()["Short"] && !headerPrinted) {
            await Logger.write(`::: Error\n\n`)
            headerPrinted = true
        }

        const ERROR_MESSAGE = error instanceof Error ? error.message : JSON.stringify(error)
        await Logger.write(`<error>\n${ERROR_MESSAGE}\n</error>`)
        
        if (lectic) {
             runHooks(lectic.header.hooks, "error", { ERROR_MESSAGE })
        } else {
             // Hook.events.emit("error", { ERROR_MESSAGE })
        }

        if (!program.opts()["Short"]) await Logger.write(`\n\n:::`)
        process.exit(1)
    }
}
