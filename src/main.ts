import { parseLectic } from "./parse"
import { program } from 'commander'
import { AnthropicBackend } from "./backends/anthopic"
import { OpenAIBackend } from "./backends/openai"
import { OllamaBackend } from "./backends/ollama"
import { GeminiBackend } from "./backends/gemini"
import { LLMProvider } from "./types/provider"
import { Logger } from "./logging/logger"
import type { Lectic } from "./types/lectic"

async function get_message(lectic : Lectic) {
    switch (lectic.header.interlocutor.provider) {
        case LLMProvider.OpenAI: {
            return OpenAIBackend.nextMessage(lectic)
        }
        case LLMProvider.Ollama: {
            return OllamaBackend.nextMessage(lectic)
        }
        case LLMProvider.Anthropic: {
            return AnthropicBackend.nextMessage(lectic)
        }
        case LLMProvider.Gemini: {
            return GeminiBackend.nextMessage(lectic)
        }
        default : {
            return AnthropicBackend.nextMessage(lectic)
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

    if (!program.opts()["short"]) {
        console.log(lecticString.trim());
    }

    await parseLectic(lecticString).then(async lectic => {
        const message =  await get_message(lectic)
        console.log(`\n::: ${lectic.header.interlocutor.name}\n\n${message.content}\n\n:::`)
    }).catch(error => {
        console.error(`\n<error>\n${error.message}\n</error>`)
        process.exit(1)
    })

}

program
.name('lectic')
.option('-s, --short', 'only emit last message rather than updated lectic')
.option('-f, --file <lectic>',  'lectic to read from or - to read stdin','-')
.option('-l, --log <logfile>',  'log debugging information')

program.parse()

main()
