import { createWriteStream } from "fs"
import { join, dirname } from "path"
import { program, type OptionValues } from 'commander'
import { parseLectic, getYaml } from "./parsing/parse"
import { Logger } from "./logging/logger"
import { getBackend } from "./backends/util"
import { version } from "../package.json"
import { lecticConfigDir, lecticEnv } from "./utils/xdg";
import { readWorkspaceConfig } from "./utils/workspace";
import { UserMessage } from "./types/message"
import { Hook } from "./types/hook"
import { startLsp } from "./lsp/server"
import { LLMProvider } from "./types/provider"
import { AnthropicBackend } from "./backends/anthropic"
import { GeminiBackend } from "./backends/gemini"
import { OpenAIResponsesBackend } from "./backends/openai-responses"
import { OpenAIBackend } from "./backends/openai"

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

async function getIncludes() : Promise<(string | null)[]> {
        const startDir = lecticEnv["LECTIC_FILE"] ? dirname(lecticEnv["LECTIC_FILE"]) : process.cwd()
        const workspaceConfig = await readWorkspaceConfig(startDir)
        const systemConfig = await Bun.file(join(lecticConfigDir(), 'lectic.yaml')).text().catch(_ => null)
        return [systemConfig, workspaceConfig]
}

async function main() {

    const opts = program.opts()

    let headerPrinted = false

    validateOptions(opts)

    if (opts["log"]) Logger.logfile = opts["log"]

    if (opts["inplace"] || opts["file"]) {
        lecticEnv["LECTIC_FILE"] = opts["inplace"] || opts["file"]
    }

    let lecticString = await getLecticString(opts)

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

        const ERROR_MESSAGE = error instanceof Error ? error.message : JSON.stringify(error)
        await Logger.write(`<error>\n${ERROR_MESSAGE}\n</error>`)
        Hook.events.emit("error", { ERROR_MESSAGE })

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
.option('-l, --log <logfile>',  'Log debugging information')
.option('-v, --version',  'Print version information')
.action(async () => { await main() })

program
.command('lsp')
.description('Start Lectic LSP server')
.action(async () => { await startLsp() })

program
.command('models')
.description('List available models for detected providers')
.action(async () => {
  const out: Array<{ name: string; models: string[] }> = []
  // Anthropic
  if (process.env['ANTHROPIC_API_KEY']) {
    const models = await AnthropicBackend.listModels()
    out.push({ name: LLMProvider.Anthropic, models })
  }
  // Gemini
  if (process.env['GEMINI_API_KEY']) {
    const models = await GeminiBackend.listModels()
    out.push({ name: LLMProvider.Gemini, models })
  }
  // OpenAI (Responses)
  if (process.env['OPENAI_API_KEY']) {
    const openai = new OpenAIResponsesBackend({
      apiKey: 'OPENAI_API_KEY',
      provider: LLMProvider.OpenAIResponses,
      defaultModel: 'gpt-5',
    })
    const models = await openai.listModels()
    out.push({ name: LLMProvider.OpenAIResponses, models })
  }
  // OpenRouter
  if (process.env['OPENROUTER_API_KEY']) {
    const openrouter = new OpenAIBackend({
      apiKey: 'OPENROUTER_API_KEY',
      provider: LLMProvider.OpenRouter,
      defaultModel: 'google/gemini-2.5-flash',
      url: 'https://openrouter.ai/api/v1',
    })
    const models = await openrouter.listModels()
    out.push({ name: LLMProvider.OpenRouter, models })
  }

  if (out.length === 0) {
    console.log('No known provider API keys detected.')
    process.exit(0)
  }

  for (const entry of out) {
    console.log(entry.name)
    for (const m of entry.models) console.log(`- ${m}`)
    if (entry.models.length === 0) console.log('- (none)')
    console.log('')
  }
})

program.parse()
