import { parseLectic } from "./parsing/parse"
import { program } from 'commander'
import type { OptionValues } from 'commander'
import { AnthropicBackend } from "./backends/anthropic"
import { OpenAIBackend } from "./backends/openai"
import { OllamaBackend } from "./backends/ollama"
import { GeminiBackend } from "./backends/gemini"
import { getDefaultProvider, LLMProvider } from "./types/provider"
import { consolidateMemories } from "./types/backend"
import { Logger } from "./logging/logger"
import * as YAML from "yaml"
import { createWriteStream } from "fs"
import type { Lectic } from "./types/lectic"
import type { Backend } from "./types/backend"
import { version } from "../package.json"

// This  really should be factored out.
function getBackend(lectic : Lectic) : Backend {
    switch (lectic.header.interlocutor.provider || getDefaultProvider()) {
        case LLMProvider.OpenAI:  return new OpenAIBackend({
            defaultModel: 'gpt-4.1',
            apiKey: 'OPENAI_API_KEY',
            provider: LLMProvider.OpenAI,
        })
        case LLMProvider.OpenRouter:  return new OpenAIBackend({
            defaultModel: 'google/gemini-2.5-flash-preview',
            apiKey: 'OPENROUTER_API_KEY',
            provider: LLMProvider.OpenRouter,
            url: 'https://openrouter.ai/api/v1'
        })
        case LLMProvider.Ollama: return OllamaBackend
        case LLMProvider.Anthropic: return AnthropicBackend
        case LLMProvider.Gemini: return GeminiBackend
    }
}

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
    if (opts["consolidate"]) {
        if (opts["short"]) {
            Logger.write("You can't combine --short and --consolidate ");
            process.exit(1)
        }
        if (opts["Short"]) {
            Logger.write("You can't combine --Short and --consolidate ");
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
    if (opts["inplace"]) {
        if (opts["file"]) {
            Logger.write("You can't combine --file and --inplace");
            process.exit(1)
        }
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

async function main() {

    const opts = program.opts()

    let headerPrinted = false

    validateOptions(opts)

    if (opts["log"]) Logger.logfile = opts["log"]

    let lecticString = await getLecticString(opts)

    if (opts["quiet"]) Logger.outfile = createWriteStream('/dev/null')

    if (!(opts["Short"] || opts["short"] || opts["consolidate"])) {
        await Logger.write(`${lecticString.trim()}\n\n`);
    }

    try {

        const lectic = await parseLectic(lecticString)

        if (program.opts()["consolidate"]) {
            const backend = getBackend(lectic)
            const new_lectic : any = await consolidateMemories(lectic, backend)
            if (new_lectic.header.interlocutors.length === 1) {
                delete new_lectic.header.interlocutors
            } else {
                delete new_lectic.header.interlocutor
            }
            if (opts["inplace"]) Logger.outfile = createWriteStream(opts["inplace"])
            await Logger.write(`---\n${YAML.stringify(new_lectic.header, {
                blockQuote: "literal" })}...`, )
        } else {
            // we handle directives, which may update header fields
            handleDirectives(lectic)

            // we then initialize, based on the contents of the header fields
            await lectic.header.initialize()

            const backend = getBackend(lectic)

            if (!program.opts()["Short"]) {
                await Logger.write(`:::${lectic.header.interlocutor.name}\n\n`)
                headerPrinted = true
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
            await Logger.write(`:::Error\n\n`)
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
.option('-c, --consolidate',  'Emit a new YAML header consolidating memories of this conversation')
.option('-f, --file <lectic>',  'Lectic to read from')
.option('-q, --quiet', 'Don’t print response')
.option('-i, --inplace <lectic>',  'Lectic to read from and update in place' )
.option('-l, --log <logfile>',  'Log debugging information')
.option('-v, --version',  'Print version information')

program.parse()

main()
