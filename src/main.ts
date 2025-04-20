import { parseLectic } from "./parsing/parse"
import { program } from 'commander'
import { AnthropicBackend } from "./backends/anthropic"
import { OpenAIBackend } from "./backends/openai"
import { OllamaBackend } from "./backends/ollama"
import { GeminiBackend } from "./backends/gemini"
import { getDefaultProvider, LLMProvider } from "./types/provider"
import { consolidateMemories } from "./types/backend"
import { Logger } from "./logging/logger"
import * as YAML from "yaml"
import type { Lectic } from "./types/lectic"
import type { Backend } from "./types/backend"
import { version } from "../package.json"

// This  really should be factored out.
function getBackend(lectic : Lectic) : Backend {
    switch (lectic.header.interlocutor.provider || getDefaultProvider()) {
        case LLMProvider.OpenAI:  return new OpenAIBackend({
            defaultModel: 'gpt-4o',
            apiKey: 'OPENAI_API_KEY',
            provider: LLMProvider.OpenAI,
        })
        case LLMProvider.OpenRouter:  return new OpenAIBackend({
            defaultModel: 'google/gemini-2.5-pro-exp-03-25:free',
            apiKey: 'OPENROUTER_API_KEY',
            provider: LLMProvider.OpenRouter,
            url: 'https://openrouter.ai/api/v1'
        })
        case LLMProvider.Ollama: return OllamaBackend
        case LLMProvider.Anthropic: return AnthropicBackend
        case LLMProvider.Gemini: return GeminiBackend
    }
}

function computeSpeaker(lectic : Lectic) {
    getSpeaker: for (let i = lectic.body.messages.length - 1; i >= 0; i--) {
        const msg = lectic.body.messages[i]
        if (msg.role === "user") {
            for (const directive of msg.containedDirectives()) {
                if (directive.name === "ask") {
                    lectic.header.setSpeaker(directive.text)
                    break getSpeaker
                }
            }
        }
        if (msg.role === "assistant") {
            lectic.header.setSpeaker(msg.name)
            break
        }
    }
}

async function main() {

    if (program.opts()["version"]) { 
        Logger.write(`${version}\n`) 
        process.exit(0)
    }

    let lecticString = program.opts()["file"] === '-' 
        ? await Bun.stdin.text()
        : await Bun.file(program.opts()["file"]).text()

    if (program.opts()["log"]) {
        Logger.logfile = program.opts()["log"]
    }


    if (program.opts()["log"]) {
        Logger.logfile = program.opts()["log"]
    }

    if ((program.opts()["Short"] || program.opts()["short"]) && program.opts()["consolidate"]) {
        Logger.write("You can't combine --short/--Short and --consolidate ");
        process.exit(1)
    }

    if (!program.opts()["Short"] && !program.opts()["short"] && !program.opts()["consolidate"]) {
        Logger.write(`${lecticString.trim()}\n\n`);
    }

    await parseLectic(lecticString).then(async lectic => {
        const backend = getBackend(lectic)
        if (program.opts()["consolidate"]) {
            const new_lectic : any = await consolidateMemories(lectic, backend)
            if (new_lectic.header.interlocutors.length === 1) {
                delete new_lectic.header.interlocutors
            } else {
                delete new_lectic.header.interlocutor
            }
            Logger.write(`---\n${YAML.stringify(new_lectic.header, {
                blockQuote: "literal" })}...`, )
        } else {
            computeSpeaker(lectic)
            !program.opts()["Short"] && Logger.write(`:::${lectic.header.interlocutor.name}\n\n`)
            const result = Logger.fromStream(backend.evaluate(lectic))
            Logger.write(result.strings)
            await result.rest
            !program.opts()["Short"] && Logger.write(`\n\n:::`)
        }
        process.exit(0)
    }).catch(error => {
        Logger.write(`<error>\n${error.message}\n</error>`)
        Logger.write(`\n\n:::`)
        process.exit(1)
    })

}

program
.name('lectic')
.option('-s, --short', 'only emit a new message rather than updated lectic')
.option('-S, --Short', 'only emit a new message rather than updated lectic, only including the message text')
.option('-c, --consolidate',  'emit a new YAML header consolidating memories of this conversation')
.option('-f, --file <lectic>',  'lectic to read from or - to read stdin','-')
.option('-l, --log <logfile>',  'log debugging information')
.option('-v, --version',  'print version information')

program.parse()

main()
