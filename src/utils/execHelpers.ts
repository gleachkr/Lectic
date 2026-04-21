import * as fs from "fs"

import { expandEnv } from "./replace"

/**
 * Parse a shell-like command string into argv pieces without using a shell.
 * - Supports simple quotes '...'
 * - Supports double quotes "..."
 * - Does not perform globbing or substitution.
 */
export function parseCommandToArgv(cmd: string): string[] {
  const unquote = (arg: string) =>
    (arg.startsWith('"') && arg.endsWith('"')) ||
    (arg.startsWith("'") && arg.endsWith("'"))
      ? arg.slice(1, -1)
      : arg
  const parts = cmd.match(/"[^"]*"|'[^']*'|\S+/g)?.map(unquote) ?? []
  return parts
}

export function parseAndExpandCommand(
  cmd: string,
  env: Record<string, string | undefined> = {}
): string[] {
  return parseCommandToArgv(cmd).map(part => expandEnv(part, env))
}

function ensureShebang(script: string) {
  if (!script.startsWith("#!")) {
    throw new Error("Expected shebang in first line of executable script")
  }
}

function shebangArgs(script: string): string[] {
  ensureShebang(script)
  return script.slice(2).split('\n')[0].trim().split(' ')
}

type TempScriptOptions = {
  registerExitCleanup?: boolean
}

function buildCleanup(
  tmpName: string,
  opt: TempScriptOptions = {}
): () => void {
  let cleaned = false
  let onExit: (() => void) | undefined

  const cleanup = () => {
    if (cleaned) return
    cleaned = true
    if (onExit) process.off('exit', onExit)
    if (fs.existsSync(tmpName)) fs.unlinkSync(tmpName)
  }

  if (opt.registerExitCleanup !== false) {
    onExit = () => cleanup()
    process.on('exit', onExit)
  }

  return cleanup
}

export function writeTempShebangScriptSync(
  script: string,
  opt: TempScriptOptions = {}
) {
  ensureShebang(script)

  // Sandboxes may change the working directory before executing argv.
  // If we write scripts to a relative path like ./.lectic_script-*, the
  // sandboxed process may fail to find it.
  //
  // Use an absolute path so argv is stable even when PWD changes.
  const tmpName = `${fs.realpathSync(".")}/.lectic_script-${Bun.randomUUIDv7()}`

  const cleanup = buildCleanup(tmpName, opt)
  fs.writeFileSync(tmpName, script)
  return { path: tmpName, shebangArgs: shebangArgs(script), cleanup }
}

export async function writeTempShebangScriptAsync(
  script: string,
  opt: TempScriptOptions = {}
) {
  ensureShebang(script)

  // See writeTempShebangScriptSync for why this must be absolute.
  const tmpName = `${fs.realpathSync(".")}/.lectic_script-${Bun.randomUUIDv7()}`

  const cleanup = buildCleanup(tmpName, opt)
  await Bun.write(tmpName, script)
  return { path: tmpName, shebangArgs: shebangArgs(script), cleanup }
}
