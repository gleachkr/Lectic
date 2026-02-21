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
import { a2aCmd } from "./a2a/a2aCmd"

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
.option('--reverse', 'Reconstruct lectic file from JSON/YAML input')
.action(parseCmd)

program
.command('a2a')
.description('Start an A2A (JSON-RPC + SSE) server for configured agents')
.requiredOption('--root <path>', 'Workspace root (process.chdir to this path)')
.option('--host <host>', 'Bind host', '127.0.0.1')
.option('--port <port>', 'Bind port', (v) => parseInt(v, 10), 41240)
.option(
    '--token <token>',
    'Require Authorization: Bearer <token> for JSON-RPC requests'
)
.option(
    '--max-tasks-per-context <n>',
    'Maximum number of tasks to keep per contextId (default 50)',
    (v) => parseInt(v, 10),
    50,
)
.action(a2aCmd)

program.parse()
