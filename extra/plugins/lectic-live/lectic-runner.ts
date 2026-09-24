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

export type BackendFailureKind = "exit" | "timeout" | "size"
  | "start" | "input" | "cleanup" | "cancelled" | "record" | "seed"

// The message may include child stderr and is local archive material only.
// The kind and exit code are the only fields safe for public diagnostics.
export class BackendFailure extends Error {
  constructor(
    readonly kind: BackendFailureKind,
    message: string,
    readonly exitCode?: number | null,
    readonly phase?: "generation" | "parse",
  ) { super(message) }
}

export function describeBackendFailure(error: unknown): string {
  if (!(error instanceof BackendFailure)) return "unexpected backend failure"
  const process = error.phase ? `backend ${error.phase} process`
    : "backend process"
  switch (error.kind) {
    case "exit": return error.exitCode === null
      ? `${process} ended without an exit code`
      : `${process} exited with code ${error.exitCode}`
    case "timeout": return `${process} timed out`
    case "size": return "backend output exceeded the size limit"
    case "start": return "backend executable could not start"
    case "input": return "backend input pipe failed"
    case "cleanup": return "backend process cleanup failed"
    case "cancelled": return "backend process was cancelled"
    case "record": return "backend result record was invalid"
    case "seed": return "backend seed changed during the run"
  }
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
  phase?: "generation" | "parse"
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
    let failure: BackendFailure | undefined
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
          failure ??= new BackendFailure("cleanup",
            "Unable to clean up backend process group", undefined, options.phase)
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
        reject(new BackendFailure("exit",
          `Backend child failed (exit ${code})`
            + (detail ? `:\n${detail}` : ""), code, options.phase))
      }
      else resolve(Buffer.concat(output).toString("utf8"))
    }
    const stop = (reason?: BackendFailure) => {
      if (reason) failure ??= reason
      if (killTimer) return
      signalGroup("SIGTERM")
      killTimer = setTimeout(() => {
        signalGroup("SIGKILL")
        lastTimer = setTimeout(() => {
          failure ??= new BackendFailure("cleanup",
            "Backend cleanup exceeded deadline", undefined, options.phase)
          finish(null)
        }, grace)
      }, grace)
    }
    const cancel = () => stop(new BackendFailure("cancelled",
      "Backend cancelled; remote outcome unknown", undefined, options.phase))
    const timeout = setTimeout(
      () => stop(new BackendFailure("timeout",
        "Backend timed out; remote outcome unknown", undefined,
        options.phase)),
      options.timeoutMs ?? 30_000,
    )
    options.signal?.addEventListener("abort", cancel, { once: true })
    if (options.signal?.aborted) cancel()
    const consume = (chunk: Buffer, retain: boolean) => {
      bytes += chunk.length
      if (bytes > limit) stop(new BackendFailure("size",
        "Backend output exceeds size limit", undefined, options.phase))
      else if (retain) output.push(chunk)
      else diagnostics = (diagnostics + chunk.toString("utf8")).slice(-2048)
    }
    child.stdout.on("data", (chunk: Buffer) => consume(chunk, true))
    child.stderr.on("data", (chunk: Buffer) => consume(chunk, false))
    child.stdin.on("error", () => stop(new BackendFailure("input",
      "Backend input pipe failed", undefined, options.phase)))
    child.on("error", () => {
      failure = new BackendFailure("start",
        "Could not start backend executable", undefined, options.phase)
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
    throw new Error("Seed exceeds size limit")
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
      ...common, cwd: options.cwd, phase: "generation",
      args: ["-f", seed, "--no-macros", "--format", "full"], input,
    })
    if (!completed.startsWith(prefix)
      || !completed.slice(prefix.length).startsWith(":::")) {
      throw new BackendFailure("record",
        "Missing newly generated backend record")
    }
    await writeFile(join(dir, "run.lec"), completed, { mode: 0o600 })
    if (await readFile(seed, "utf8") !== original) {
      throw new BackendFailure("seed",
        "Seed changed during backend run; result withheld")
    }
    // Parse the managed record on stdin, not -f state/run.lec. This keeps
    // document-relative imports and workspace discovery at the seed base.
    // Parsing does not initialize tools, load prompts, or expand macros.
    const parsed = await runChild({
      ...common, cwd: dirname(seed), phase: "parse",
      args: ["parse"], input: completed,
      maxBytes: 4 * 1024 * 1024,
    })
    options.signal?.throwIfAborted()
    try {
      return extractResult(JSON.parse(parsed))
    } catch (error) {
      throw new BackendFailure("record",
        `Invalid backend record: ${String(error)}`)
    }
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
