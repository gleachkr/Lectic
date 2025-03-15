import { parseLectic } from "./parse"
import { program } from 'commander'
import { AnthropicBackend } from "./backends/anthropic"
import { OpenAIBackend } from "./backends/openai"
import { OllamaBackend } from "./backends/ollama"
import { GeminiBackend } from "./backends/gemini"
import { LLMProvider } from "./types/provider"
import { consolidateMemories } from "./types/backend"
import { Logger } from "./logging/logger"
import { Message } from "./types/message"
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

async function get_message(lectic : Lectic) : Promise<Message> {
    return getBackend(lectic).nextMessage(lectic)
}

async function main() {

    let lecticString = program.opts()["file"] === '-' 
        ? await Bun.stdin.text()
        : await Bun.file(program.opts()["file"]).text()

    if (program.opts()["log"]) {
        Logger.logfile = program.opts()["log"]
    }

    if (!program.opts()["short"] && !program.opts()["consolidate"]) {
        console.log(lecticString.trim());
    }

    await parseLectic(lecticString).then(async lectic => {
        if (program.opts()["consolidate"]) {
            const new_lectic = await consolidateMemories(lectic, getBackend(lectic))
            console.log(`---\n${YAML.stringify(new_lectic.header)}...`)
        } else {
            const message =  await get_message(lectic)
            console.log(`\n::: ${lectic.header.interlocutor.name}\n\n${message.content.trim()}\n\n:::`)
        }
    }).catch(error => {
        console.error(`\n<error>\n${error.message}\n</error>`)
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
