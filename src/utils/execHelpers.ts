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

function unlinkIfExists(path: string): void {
  try {
    if (fs.existsSync(path)) fs.unlinkSync(path)
  } catch {
    // Best effort cleanup. Callers should not fail because a temp file was
    // concurrently removed or could not be removed during shutdown.
  }
}

function buildCleanup(tmpName: string): () => void {
  let cleaned = false

  return () => {
    if (cleaned) return
    cleaned = true
    unlinkIfExists(tmpName)
  }
}

type KillSignal = NodeJS.Signals | number

type ManagedProcess = {
  exited: Promise<number>
  kill: (signal?: KillSignal) => unknown
}

type ManagedTempScript = {
  proc: ManagedProcess
  cleanup: () => void
}

const managedTempScripts = new Set<ManagedTempScript>()
let signalHandlersInstalled = false
let signalShutdownStarted = false

function installSignalHandlers(): void {
  if (signalHandlersInstalled) return
  signalHandlersInstalled = true

  process.once("SIGTERM", () => {
    void cleanupForSignal("SIGTERM", 128 + 15)
  })

  process.once("SIGINT", () => {
    void cleanupForSignal("SIGINT", 128 + 2)
  })
}

async function cleanupForSignal(signal: KillSignal, exitCode: number) {
  if (signalShutdownStarted) process.exit(exitCode)
  signalShutdownStarted = true

  const children = [...managedTempScripts]

  for (const child of children) {
    try {
      child.proc.kill(signal)
    } catch {
      // Keep trying to clean up the rest.
    } finally {
      managedTempScripts.delete(child)
      child.cleanup()
    }
  }

  await Promise.allSettled(children.map(child => Promise.race([
    child.proc.exited.catch(() => undefined),
    Bun.sleep(2_000),
  ])))

  process.exit(exitCode)
}

export function cleanupTempScriptAfterProcess(
  proc: ManagedProcess,
  cleanup: () => void
): Promise<number> {
  installSignalHandlers()

  const child = { proc, cleanup }
  managedTempScripts.add(child)

  return proc.exited.finally(() => {
    managedTempScripts.delete(child)
    cleanup()
  })
}

export function writeTempShebangScriptSync(script: string) {
  ensureShebang(script)

  // Sandboxes may change the working directory before executing argv.
  // If we write scripts to a relative path like ./.lectic_script-*, the
  // sandboxed process may fail to find it.
  //
  // Use an absolute path so argv is stable even when PWD changes.
  const tmpName = `${fs.realpathSync(".")}/.lectic_script-${Bun.randomUUIDv7()}`

  const cleanup = buildCleanup(tmpName)
  fs.writeFileSync(tmpName, script)
  return { path: tmpName, shebangArgs: shebangArgs(script), cleanup }
}

export async function writeTempShebangScriptAsync(script: string) {
  ensureShebang(script)

  // See writeTempShebangScriptSync for why this must be absolute.
  const tmpName = `${fs.realpathSync(".")}/.lectic_script-${Bun.randomUUIDv7()}`

  const cleanup = buildCleanup(tmpName)
  await Bun.write(tmpName, script)
  return { path: tmpName, shebangArgs: shebangArgs(script), cleanup }
}
