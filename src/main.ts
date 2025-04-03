import { parseLectic } from "./parsing/parse"
import { program } from 'commander'
import { AnthropicBackend } from "./backends/anthropic"
import { OpenAIBackend } from "./backends/openai"
import { OllamaBackend } from "./backends/ollama"
import { GeminiBackend } from "./backends/gemini"
import { LLMProvider } from "./types/provider"
import { consolidateMemories } from "./types/backend"
import { Logger } from "./logging/logger"
import * as YAML from "yaml"
import type { Lectic } from "./types/lectic"
import type { Backend } from "./types/backend"

// This  really should be factored out.
function getBackend(lectic : Lectic) : Backend {
    switch (lectic.header.interlocutor.provider) {
        case LLMProvider.OpenAI:  return OpenAIBackend
        case LLMProvider.Ollama: return OllamaBackend
        case LLMProvider.Anthropic: return AnthropicBackend
        case LLMProvider.Gemini: return GeminiBackend
        default : return AnthropicBackend
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

    let lecticString = program.opts()["file"] === '-' 
        ? await Bun.stdin.text()
        : await Bun.file(program.opts()["file"]).text()

    if (program.opts()["log"]) {
        Logger.logfile = program.opts()["log"]
    }

    if (!program.opts()["short"] && !program.opts()["consolidate"]) {
        Logger.stdout(`${lecticString.trim()}\n\n`);
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
            Logger.stdout(`---\n${YAML.stringify(new_lectic.header, {
                blockQuote: "literal" })}...`, )
        } else {
            computeSpeaker(lectic)
            Logger.stdout(`:::${lectic.header.interlocutor.name}\n\n`)
            const result = Logger.fromStream(backend.evaluate(lectic))
            Logger.stdout(result.strings)
            await result.rest
            Logger.stdout(`\n\n:::`)
        }
    }).catch(error => {
        Logger.stdout(`<error>\n${error.message}\n</error>`)
        Logger.stdout(`\n\n:::`)
        process.exit(1)
    })

}

program
.name('lectic')
.option('-s, --short', 'only emit last message rather than updated lectic')
.option('-c, --consolidate',  'emit a new YAML header consolidating memories of this conversation')
.option('-f, --file <lectic>',  'lectic to read from or - to read stdin','-')
.option('-l, --log <logfile>',  'log debugging information')

program.parse()

main()
