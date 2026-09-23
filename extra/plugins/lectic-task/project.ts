import { createHash } from "node:crypto"
import { basename, resolve } from "node:path"

// Project identity resolution, mirroring lectic-memory so both plugins agree
// on what "the current project" means. Keys are derived (in order) from an
// explicit override, the Git origin + repo name, or the working directory.

export type ProjectIdentity = {
  key: string
  source: "override" | "git" | "directory"
  // Human-readable name for display only: the override itself, the repo's
  // directory name, or the working directory's basename. Never stored.
  label: string
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 24)
}

function gitOutput(args: string[], cwd: string): string | undefined {
  const proc = Bun.spawnSync({
    cmd: ["git", ...args],
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  })
  if (proc.exitCode !== 0) return undefined
  const output = proc.stdout.toString().trim()
  return output || undefined
}

export function projectIdentity(
  override?: string,
  cwd: string = process.cwd(),
): ProjectIdentity {
  if (override?.trim()) {
    const key = override.trim()
    return { key, source: "override", label: key }
  }

  const root = gitOutput(["rev-parse", "--show-toplevel"], cwd)
  if (root) {
    const remote = gitOutput(["remote", "get-url", "origin"], cwd)
    const name = root.split(/[\\/]/).pop() ?? root
    const basis = remote ? `${remote}\n${name}` : root
    return { key: `git:${hash(basis)}`, source: "git", label: name }
  }

  const dir = resolve(cwd)
  return {
    key: `dir:${hash(dir)}`,
    source: "directory",
    label: basename(dir) || dir,
  }
}

export function defaultDbPath(): string {
  const defaultData = process.env["LECTIC_DATA"]
    ?? `${process.env["HOME"] ?? "."}/.local/share/lectic`
  return process.env["LECTIC_TASK_DB"] ?? `${defaultData}/task/task.sqlite3`
}
