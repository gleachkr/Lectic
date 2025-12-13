//monkey patch fetch to avoid timeout with some thinking models, codex
const originalFetch = globalThis.fetch
globalThis.fetch = Object.assign(
    function (req : string | URL | Request, opt? : RequestInit) { 
        const withTimeout: RequestInit & { timeout?: number | false } = opt
            ? { ...opt, timeout: false }
            : { timeout: false }
        return originalFetch(req, withTimeout)
    }, originalFetch)

import { program } from 'commander'
import { startLsp } from "./lsp/server"
import { generate } from "./generateCmd"
import { listModels } from "./modelCmd"
import { parseCmd } from "./parseCmd"
import { tryRunSubcommand } from "./subcommandCmd"
import { scriptCmd } from "./scriptCmd"

program
.name('lectic')
.enablePositionalOptions()
.passThroughOptions()
.option('-s, --short', 'Only emit a new message rather than the full updated lectic')
.option('-S, --Short', 'Only emit a new message rather than the full updated lectic. Only including the message text')
.option('-f, --file <lectic>',  'Lectic to read from')
.option('-q, --quiet', 'Don’t print response')
.option('-i, --inplace <lectic>',  'Lectic to read from and update in place' )
.option('-l, --log <logfile>',  'Log debugging information')
.option('-v, --version',  'Print version information')
.argument('[subcommand]', 'Subcommand to run')
.argument('[args...]', 'Arguments for subcommand')
.action(async (subcommand, args) => {
    if (subcommand) {
        await tryRunSubcommand(subcommand, args || [])
    } else {
        await generate()
    }
})

program
.command('lsp')
.description('Start Lectic LSP server')
.action(startLsp)

program
.command('models')
.description('List available models for detected providers')
.action(listModels)

program
.command('script')
.description(
    'Experimental: run a JS/TS module as a hashbang-style script. The module '
    + 'must export a function named main().'
)
.allowExcessArguments(true)
.argument('[args...]', 'Module path followed by any script args')
.action(async (args: string[]) => {
    await scriptCmd(args)
})

program
.command('parse')
.description('Parse a lectic file into JSON/YAML structure, or reverse the process')
.option('--yaml', 'Emit output as YAML instead of JSON')
.option('--reverse', 'Reconstruct lectic file from JSON/YAML input')
.action(parseCmd)

program.parse()
