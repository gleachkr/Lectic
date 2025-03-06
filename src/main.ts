import { parseLectic } from "./parse"
import { program } from 'commander'
import { AnthropicBackend } from "./backends/anthopic"
import { OpenAIBackend } from "./backends/openai"
import { OllamaBackend } from "./backends/ollama"
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
      default : {
          return AnthropicBackend.nextMessage(lectic)
      }
  }
}

async function main() {

  let lecticString = program.opts()["file"] === '-' 
      ? await Bun.stdin.text()
      : await Bun.file(program.opts()["file"]).text()

  const lectic = await parseLectic(lecticString)

  if (lectic instanceof Error) {
      console.error(lectic.message)
      process.exit(1)
  }

  if (program.opts()["log"]) {
      Logger.logfile = program.opts()["log"]
  }

  const message = await get_message(lectic)

  if (!program.opts()["short"]) {
      console.log(lecticString.trim());
  }

  console.log(`
::: ${lectic.header.interlocutor.name}

${message.content}
  
:::`)
}

program
    .name('lectic')
    .option('-s, --short', 'only emit last message rather than updated lectic')
    .option('-f, --file <lectic>',  'lectic to read from or - to read stdin','-')
    .option('-l, --log <logfile>',  'log debugging information')

program.parse()

main()
