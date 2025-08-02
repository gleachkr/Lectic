import { createWriteStream } from "fs"
import { join } from "path"
import { program, type OptionValues } from 'commander'
import { parseLectic, getYaml } from "./parsing/parse"
import { Logger } from "./logging/logger"
import { getBackend } from "./backends/util"
import type { Lectic } from "./types/lectic"
import { version } from "../package.json"
import { lecticConfigDir } from "./utils/xdg";
import { UserMessage } from "./types/message"

// XXX This really should be factored out.
function handleDirectives(lectic : Lectic) {
    for (const message of lectic.body.messages) {
        if (message.role === "user") {
            for (const directive of message.containedDirectives()) {
                if (directive.name === "ask") {
                    lectic.header.setSpeaker(directive.text)
                }
            }
        }
    }
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

async function getIncludes(opts: OptionValues) : Promise<(string | null)[]> {
        const includes = []
        if (opts["Include"]) {
            includes.push(await Bun.file(opts["Include"])
                    .text().catch(_ => null))
        }
        includes.push(await Bun.file(join(lecticConfigDir(), 'lectic.yaml'))
                .text().catch(_ => null))
        return includes
}

async function main() {

    const opts = program.opts()

    let headerPrinted = false


    validateOptions(opts)

    if (opts["log"]) Logger.logfile = opts["log"]

    let lecticString = await getLecticString(opts)

    if (opts["quiet"]) Logger.outfile = createWriteStream('/dev/null')

    if (!(opts["Short"] || opts["short"] || opts["header"])) {
        await Logger.write(`${lecticString.trim()}\n\n`);
    }

    try {

        const includes = await getIncludes(opts)

        const lectic = await parseLectic(lecticString, includes)

        for (const message of lectic.body.messages) {
            if (message instanceof UserMessage) {
                await message.expandMacros(lectic.header.macros)
            }
        }

        if (opts["header"]) {
            const newHeader = `---\n${getYaml(lecticString) ?? ""}\n---`
            await Logger.write(newHeader)
            if (opts["inplace"]) {
                Logger.outfile = createWriteStream(opts["inplace"])
                await Logger.write(newHeader)
            }
        } else {
            // we handle directives, which may update header fields
            handleDirectives(lectic)

            const backend = getBackend(lectic.header.interlocutor)

            if (!program.opts()["Short"]) {
                await Logger.write(`:::${lectic.header.interlocutor.name}\n\n`)
                headerPrinted = true
                let closeHeader = () => { Logger.write(`\n\n:::`).then(() => process.exit(0)) }
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
        if (error instanceof Error) {
            await Logger.write(`<error>\n${error.message}\n</error>`)
        } else {
            await Logger.write(`<error>\n${JSON.stringify(error)}\n</error>`)
        }
        if (!program.opts()["Short"]) await Logger.write(`\n\n:::`)
        process.exit(1)
    }
}

program
.name('lectic')
.option('-s, --short', 'Only emit a new message rather than the full updated lectic')
.option('-S, --Short', 'Only emit a new message rather than the full updated lectic. Only including the message text')
.option('-H, --header',  'Emit only the YAML header of the lectic')
.option('-f, --file <lectic>',  'Lectic to read from')
.option('-q, --quiet', 'Don’t print response')
.option('-i, --inplace <lectic>',  'Lectic to read from and update in place' )
.option('-I, --Include <yaml>',  'Include extra header information' )
.option('-l, --log <logfile>',  'Log debugging information')
.option('-v, --version',  'Print version information')

program.parse()

main()
