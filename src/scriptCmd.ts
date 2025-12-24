import { pathToFileURL } from "url"
import { resolve } from "path"

import { Logger } from "./logging/logger"

function usage(): string {
    return (
        "usage: lectic script <module-path> [args...]\n"
        + "\n"
        + "This is experimental. The module must export a default function\n"
        + "Script arguments are available via process.argv.\n"
    )
}

export async function scriptCmd(args: string[]) {
    if (args.length === 0 || (args.length === 1 && (args[0] === '-h' || args[0] === '--help'))) {
        if (args.length === 0) Logger.write("error: script requires a module path\n")
        Logger.write(usage())
        process.exit(args.length === 0 ? 1 : 0)
    }

    const scriptPathRaw = args[0]
    const scriptPath = resolve(process.cwd(), scriptPathRaw)

    process.argv = [
        process.argv[0] || "bun",
        scriptPath,
        ...args.slice(1),
    ]

    const modUrl = pathToFileURL(scriptPath).href

    let mod: unknown
    try {
        mod = await import(modUrl)
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        Logger.write(`error: failed to import script module '${scriptPath}': ${msg}\n${usage()}`)
        process.exit(1)
    }

    const entryFn = (mod as Record<string, unknown>)["default"] 

    if (typeof entryFn === "function") {
        try {
            await Promise.resolve(entryFn())
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e)
            Logger.write(`error: script default function threw: ${msg}\n`)
            process.exit(1)
        }
    }

}
