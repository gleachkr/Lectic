import { constants, existsSync, realpathSync, statSync } from "node:fs"
import { delimiter } from "node:path"

import { Logger } from "./logging/logger"
import { lecticConfigDir, lecticDataDir, lecticEnv } from "./utils/xdg"

type SearchDir = {
  dir: string
  recursive: boolean
}

type ResolveSubcommandResult =
  | { kind: "found", path: string }
  | { kind: "error", message: string }

const EXEC_MASK =
  constants.S_IXUSR |
  constants.S_IXGRP |
  constants.S_IXOTH

function runtimeSearchDirs(): SearchDir[] | null {
  const runtime = process.env["LECTIC_RUNTIME"]
  if (runtime === undefined) return null

  return runtime
    .split(delimiter)
    .map(dir => dir.trim())
    .filter(Boolean)
    .map(dir => ({ dir, recursive: true }))
}

function defaultSearchDirs(): SearchDir[] {
  const pathDirs = (process.env["PATH"] || "")
    .split(delimiter)
    .filter(Boolean)

  const recursiveDirs = runtimeSearchDirs() ?? [
    { dir: lecticConfigDir(), recursive: true },
    { dir: lecticDataDir(), recursive: true },
  ]

  return [
    ...recursiveDirs,
    ...pathDirs.map(dir => ({ dir, recursive: false })),
  ]
}

function isExecutable(path: string): boolean {
  try {
    const st = statSync(path)
    return st.isFile() && (st.mode & EXEC_MASK) !== 0
  } catch {
    return false
  }
}

function scanDirForCommand(
  dir: string,
  command: string,
  recursive: boolean
): string[] {
  if (!existsSync(dir)) return []

  let st
  try {
    st = statSync(dir)
  } catch {
    return []
  }
  if (!st.isDirectory()) return []

  const pattern = recursive
    ? `**/lectic-${command}{,.*}`
    : `lectic-${command}{,.*}`

  const glob = new Bun.Glob(pattern)
  const found = new Set<string>()

  for (const maybePath of glob.scanSync({
    cwd: dir,
    absolute: true,
    onlyFiles: true,
    followSymlinks: true,
  })) {
    if (!isExecutable(maybePath)) continue

    try {
      found.add(realpathSync(maybePath))
    } catch {
      // Ignore broken symlinks or races.
    }
  }

  return [...found].sort()
}

export function resolveSubcommandPath(
  command: string,
  searchDirs: SearchDir[] = defaultSearchDirs()
): ResolveSubcommandResult {
  for (const loc of searchDirs) {
    const matches = scanDirForCommand(loc.dir, command, loc.recursive)

    if (matches.length > 1) {
      return {
        kind: "error",
        message: `multiple commands available:\n ${matches.join("\n")}\n`,
      }
    }

    if (matches.length === 1) {
      return { kind: "found", path: matches[0] }
    }
  }

  return {
    kind: "error",
    message: `error: couldn't identify command '${command}'\n`,
  }
}

export async function tryRunSubcommand(command: string, args: string[]) {
  const result = resolveSubcommandPath(command)

  if (result.kind === "error") {
    await Logger.write(result.message)
    process.exit(1)
  }

  await runExecutable(result.path, args)
}

async function runExecutable(path: string, args: string[]) {
  const env = { ...process.env, ...lecticEnv }

  try {
    const proc = Bun.spawn([path, ...args], {
      env,
      stdio: ["inherit", "inherit", "inherit"],
    })

    const exitCode = await proc.exited
    process.exit(exitCode)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    await Logger.write(
      `error: failed to execute subcommand '${path}': ${msg}\n`
    )
    process.exit(1)
  }
}
