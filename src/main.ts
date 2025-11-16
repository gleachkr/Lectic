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
import { completions } from "./completions"
import { listModels } from "./models"

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
.action(completions)

program
.command('lsp')
.description('Start Lectic LSP server')
.action(startLsp)

program
.command('models')
.description('List available models for detected providers')
.action(listModels)

program.parse()
