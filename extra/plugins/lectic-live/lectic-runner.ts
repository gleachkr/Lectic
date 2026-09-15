import { spawn } from "node:child_process"
import { mkdir, mkdtemp, writeFile, rm, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { backendPrompt } from "./prompts"
import { serializeContext, type ContextEnvelope } from "./transcript"
import { extractResult } from "./result"

export function resolveLectic(): string[] {
  // process.execPath can be Bun or Lectic's bundled runtime; neither is a
  // reliable indication of the CLI to invoke. Resolve the public command.
  const executable = Bun.which("lectic")
  if (!executable) throw new Error("Cannot find lectic on PATH")
  return [executable]
}

export type ChildOptions = {
  command: string[]
  args: string[]
  input: string
  cwd: string
  env?: NodeJS.ProcessEnv
  signal?: AbortSignal
  timeoutMs?: number
  graceMs?: number
  maxBytes?: number
}

export function runChild(options: ChildOptions): Promise<string> {
  if (process.platform === "win32") {
    return Promise.reject(
      new Error("Lectic Live requires POSIX process groups"),
    )
  }
  options.signal?.throwIfAborted()
  const [executable, ...prefix] = options.command
  if (!executable) throw new Error("Missing executable")
  const grace = options.graceMs ?? 200
  const limit = options.maxBytes ?? 1024 * 1024
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [...prefix, ...options.args], {
      cwd: options.cwd, env: options.env ?? process.env,
      detached: true, stdio: ["pipe", "pipe", "pipe"],
    })
    let failure: Error | undefined
    let bytes = 0
    const output: Buffer[] = []
    // Keep a short stderr tail so a nonzero exit is diagnosable (for example
    // a stale lectic on PATH rejecting a newer option), without retaining
    // unbounded diagnostics in memory.
    let diagnostics = ""
    let killTimer: ReturnType<typeof setTimeout> | undefined
    let lastTimer: ReturnType<typeof setTimeout> | undefined
    let settled = false
    const signalGroup = (signal: NodeJS.Signals) => {
      if (!child.pid) return
      try { process.kill(-child.pid, signal) } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
          failure ??= new Error("Unable to clean up backend process group")
        }
      }
    }
    const cleanup = () => {
      clearTimeout(timeout)
      clearTimeout(killTimer)
      clearTimeout(lastTimer)
      options.signal?.removeEventListener("abort", cancel)
      signalGroup("SIGKILL")
      child.stdin.destroy()
      child.stdout.destroy()
      child.stderr.destroy()
    }
    const finish = (code: number | null) => {
      if (settled) return
      settled = true
      cleanup()
      if (failure) reject(failure)
      else if (code !== 0) {
        const detail = diagnostics.trim()
        reject(new Error(`Backend child failed (exit ${code})`
          + (detail ? `:\n${detail}` : "")))
      }
      else resolve(Buffer.concat(output).toString("utf8"))
    }
    const stop = (reason?: string) => {
      if (reason) failure ??= new Error(reason)
      if (killTimer) return
      signalGroup("SIGTERM")
      killTimer = setTimeout(() => {
        signalGroup("SIGKILL")
        lastTimer = setTimeout(() => {
          failure ??= new Error("Backend cleanup exceeded deadline")
          finish(null)
        }, grace)
      }, grace)
    }
    const cancel = () => stop("Backend cancelled; remote outcome unknown")
    const timeout = setTimeout(
      () => stop("Backend timed out; remote outcome unknown"),
      options.timeoutMs ?? 30_000,
    )
    options.signal?.addEventListener("abort", cancel, { once: true })
    if (options.signal?.aborted) cancel()
    const consume = (chunk: Buffer, retain: boolean) => {
      bytes += chunk.length
      if (bytes > limit) stop("Backend output exceeds size limit")
      else if (retain) output.push(chunk)
      else diagnostics = (diagnostics + chunk.toString("utf8")).slice(-2048)
    }
    child.stdout.on("data", (chunk: Buffer) => consume(chunk, true))
    child.stderr.on("data", (chunk: Buffer) => consume(chunk, false))
    child.stdin.on("error", () => stop("Backend input pipe failed"))
    child.on("error", () => {
      failure = new Error("Could not start backend executable")
      finish(null)
    })
    // A leader exiting does not prove its tools/MCP/hook children exited.
    child.on("exit", () => stop())
    child.on("close", finish)
    child.stdin.end(options.input)
  })
}

export type RunOptions = {
  seed: string
  cwd: string
  command?: string[]
  env?: NodeJS.ProcessEnv
  signal?: AbortSignal
  timeoutMs?: number
  historyDir?: string
}

export async function runLectic(
  context: ContextEnvelope,
  options: RunOptions,
) {
  const seed = resolve(options.cwd, options.seed)
  const original = await readFile(seed, "utf8")
  if (Buffer.byteLength(original) > 512 * 1024) {
    throw new Error("Seed exceeds spike limit")
  }
  const input = `\n\n${backendPrompt}\n${serializeContext(context)}`
  const prefix = `${(original + "\n\n" + input).trim()}\n\n`
  const command = options.command ?? resolveLectic()
  if (options.historyDir) {
    await mkdir(options.historyDir, { recursive: true, mode: 0o700 })
  }
  const dir = await mkdtemp(join(
    options.historyDir ?? tmpdir(), "lectic-live-",
  ))
  const common = {
    command, env: options.env, signal: options.signal,
    timeoutMs: options.timeoutMs,
  }
  try {
    if (options.historyDir) {
      await writeFile(join(dir, "request.json"), JSON.stringify(context),
        { mode: 0o600 })
    }
    // No --inplace. Keep both config discovery and LECTIC_FILE tied to seed.
    const completed = await runChild({
      ...common, cwd: options.cwd,
      args: ["-f", seed, "--no-macros", "--format", "full"], input,
    })
    if (!completed.startsWith(prefix)
      || !completed.slice(prefix.length).startsWith(":::")) {
      throw new Error("Missing newly generated backend record")
    }
    await writeFile(join(dir, "run.lec"), completed, { mode: 0o600 })
    if (await readFile(seed, "utf8") !== original) {
      throw new Error("Seed changed during backend run; result withheld")
    }
    // Parse the managed record on stdin, not -f state/run.lec. This keeps
    // document-relative imports and workspace discovery at the seed base.
    // Parsing does not initialize tools, load prompts, or expand macros.
    const parsed = await runChild({
      ...common, cwd: dirname(seed), args: ["parse"], input: completed,
      maxBytes: 4 * 1024 * 1024,
    })
    options.signal?.throwIfAborted()
    return extractResult(JSON.parse(parsed))
  } catch (error) {
    if (options.historyDir) {
      await writeFile(join(dir, "error.txt"), String(error) + "\n",
        { mode: 0o600 })
    }
    throw error
  } finally {
    if (!options.historyDir) {
      await rm(dir, { recursive: true, force: true })
    }
  }
}
