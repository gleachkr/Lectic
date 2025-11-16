import { createWriteStream } from "fs"
import { join, dirname } from "path"
import { parseLectic, getYaml } from "./parsing/parse"
import { Logger } from "./logging/logger"
import { getBackend } from "./backends/util"
import { version } from "../package.json"
import { lecticConfigDir, lecticEnv } from "./utils/xdg";
import { readWorkspaceConfig } from "./utils/workspace";
import { UserMessage } from "./types/message"
import { Hook } from "./types/hook"
import { program, type OptionValues } from 'commander'

async function getLecticString(opts : OptionValues) : Promise<string> {
    if (opts["inplace"] || opts["file"]) {
        const path = opts["inplace"] || opts["file"]
        const fileText = await Bun.file(path).text()
        const pipeText = process.stdin.isTTY ? "" : `\n\n${await Bun.stdin.text()}` 
        return fileText + pipeText
    } else {
        return Bun.stdin.text()
    }
}

async function getIncludes() : Promise<(string | null)[]> {
        const startDir = lecticEnv["LECTIC_FILE"] ? dirname(lecticEnv["LECTIC_FILE"]) : process.cwd()
        const workspaceConfig = await readWorkspaceConfig(startDir)
        const systemConfig = await Bun.file(join(lecticConfigDir(), 'lectic.yaml')).text().catch(() => null)
        return [systemConfig, workspaceConfig]
}

function validateOptions(opts : OptionValues) {
    if (opts["header"]) {
        if (opts["short"]) {
            Logger.write("You can't combine --short and --header ");
            process.exit(1)
        }
        if (opts["Short"]) {
            Logger.write("You can't combine --Short and --header ");
            process.exit(1)
        }
    }
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

export async function completions() {

    const opts = program.opts()

    let headerPrinted = false

    validateOptions(opts)

    if (opts["log"]) Logger.logfile = opts["log"]

    if (opts["inplace"] || opts["file"]) {
        lecticEnv["LECTIC_FILE"] = opts["inplace"] || opts["file"]
    }

    const lecticString = await getLecticString(opts)

    if (opts["quiet"]) Logger.outfile = createWriteStream('/dev/null')

    if (!(opts["Short"] || opts["short"] || opts["header"])) {
        await Logger.write(`${lecticString.trim()}\n\n`);
    }

    try {

        const includes = await getIncludes()

        const lectic = await parseLectic(lecticString, includes)

        if (opts["header"]) {
            const newHeader = `---\n${getYaml(lecticString) ?? ""}\n---`
            await Logger.write(newHeader)
            if (opts["inplace"]) {
                Logger.outfile = createWriteStream(opts["inplace"])
                await Logger.write(newHeader)
            }
        } else {

            for (const message of lectic.body.messages) {
                if (message instanceof UserMessage) {
                    await message.expandMacros(lectic.header.macros)
                }
            }

            if (lectic.body.messages.at(-1) instanceof UserMessage) {
                Hook.events.emit("user_message", {
                    "USER_MESSAGE" : lectic.body.messages.at(-1)?.content ?? ""
                })
            }

            // we handle directives, which may update header fields
            lectic.handleDirectives()

            // we initialize, starting MCP servers for the active interlocutor
            await lectic.header.initialize()

            const backend = getBackend(lectic.header.interlocutor)

            if (!program.opts()["Short"]) {
                await Logger.write(`:::${lectic.header.interlocutor.name}\n\n`)
                headerPrinted = true
                const closeHeader = () => { Logger.write(`\n\n:::`).then(() => process.exit(0)) }
                process.on('SIGTERM', closeHeader)
                process.on('SIGINT', closeHeader)
            }

            const result = Logger.fromStream(backend.evaluate(lectic))
            await Logger.write(result.chunks)
            await result.rest

            if (!program.opts()["Short"]) await Logger.write(`\n\n:::`)

            if (opts["inplace"]) {
                Logger.outfile = createWriteStream(opts["inplace"])
                await Logger.write(`${lecticString.trim()}\n\n`)
                await Logger.write(`:::${lectic.header.interlocutor.name}\n\n`)
                await result.string.then(string => Logger.write(string))
                await Logger.write(`\n\n:::`)
            }
        }
        process.exit(0)
    } catch (error) {

        if (!program.opts()["Short"] && !headerPrinted) {
            await Logger.write(`::: Error\n\n`)
            headerPrinted = true
        }

        const ERROR_MESSAGE = error instanceof Error ? error.message : JSON.stringify(error)
        await Logger.write(`<error>\n${ERROR_MESSAGE}\n</error>`)
        Hook.events.emit("error", { ERROR_MESSAGE })

        if (!program.opts()["Short"]) await Logger.write(`\n\n:::`)
        process.exit(1)
    }
}
