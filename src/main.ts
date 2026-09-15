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
.option('--no-macros', 'Leave macros and built-in directives unevaluated')
.option('--format <mode>', 'Output format: full|block|raw|clean|none')
.option('-f, --file <lectic>',  'Lectic to read from')
.option('-i, --inplace', 'Update the file in place (requires --file)')
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
    'Experimental: bundle then run a JS/TS/JSX/TSX module as a '
    + 'hashbang-style script. Supports HTTP(S) imports during bundling. If '
    + 'the module exports a default function, it will be executed after '
    + 'import.'
)
.allowExcessArguments(true)
.passThroughOptions()
.helpOption(false)
.argument('[args...]', 'Module path followed by any script args')
.action(async (args: string[]) => {
    const code = await scriptCmd(args)
    process.exit(code)
})

program
.command('parse')
.description('Parse a lectic file into JSON/YAML structure, or reverse the process')
.option('-f, --file <lectic>', 'Lectic to read from')
.option('--yaml', 'Emit output as YAML instead of JSON')
.option('--effective-header', 'Emit resolved configuration, without loading it')
.option('--reverse', 'Reconstruct lectic file from JSON/YAML input')
.action(parseCmd)

await program.parseAsync()
