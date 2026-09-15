#!/usr/bin/env -S lectic script
import { join, resolve } from "node:path"
import { History, loadHistory } from "./history"
import { backendPrompt } from "./prompts"
import { resolveLectic, runLectic } from "./lectic-runner"
import { liveConnector } from "./session"
import { startServer } from "./server"

export function parseArgs(args: string[]) {
  const result = {
    seed: "", noOpen: false, port: 0, voice: undefined as string | undefined,
    maxSessionSeconds: 600, backendTimeout: 120, contextSeconds: 300,
    idleTimeout: 30,
    keepHistory: false, resume: undefined as string | undefined,
  }
  for (let n = 0; n < args.length; n++) {
    const arg = args[n]
    if (arg === "--no-open") { result.noOpen = true; continue }
    if (arg === "--keep-history") { result.keepHistory = true; continue }
    if (!["-f", "--port", "--voice", "--max-session-seconds",
      "--backend-timeout", "--context-seconds", "--idle-timeout", "--resume",
    ].includes(arg)) {
      throw new Error(`Unknown option: ${arg}`)
    }
    const value = args[++n]
    if (!value || value.startsWith("--")) {
      throw new Error(`Missing value for ${arg}`)
    }
    if (arg === "-f") result.seed = value
    else if (arg === "--resume") {
      if (!/^[a-f0-9-]{36}$/.test(value)) {
        throw new Error("Invalid history ID")
      }
      result.resume = value
      result.keepHistory = true
    } else if (arg === "--voice") {
      if (!/^[a-z][a-z0-9_-]{0,63}$/.test(value)) {
        throw new Error("Invalid voice name")
      }
      result.voice = value
    } else {
      const number = Number(value)
      if (!Number.isInteger(number) || number < (arg === "--port" ? 0 : 1)
        || number > (arg === "--port" ? 65535 : 3600)) {
        throw new Error(`Invalid value for ${arg}`)
      }
      if (arg === "--port") result.port = number
      if (arg === "--max-session-seconds") result.maxSessionSeconds = number
      if (arg === "--backend-timeout") result.backendTimeout = number
      if (arg === "--idle-timeout") result.idleTimeout = number
      if (arg === "--context-seconds") result.contextSeconds = number
    }
  }
  if (!result.seed) throw new Error("Required: -f ./voice-backend.lec")
  return result
}

export default async function main() {
  const args = process.argv.slice(2)
  if (args.length === 1 && args[0] === "--spike-info") {
    console.log(JSON.stringify({
      stage: 3, executable: resolveLectic(), backendPrompt,
    }))
    return
  }
  if (!args.length || (args.length === 1 && args[0] === "--help")) {
    console.log(`lectic live -f ./voice-backend.lec [options]
  --no-open                 Print URL without opening the browser
  --port N                  Loopback port (default: automatic)
  --voice NAME              Voice chosen at session creation
  --max-session-seconds N    Voice time budget (default: 600, max: 3600)
  --idle-timeout N           Idle disconnect (default: 30 seconds)
  --backend-timeout N        Backend phase timeout (default: 120 seconds)
  --context-seconds N        Recent context window (default: 300 seconds)
  --keep-history             Save local transcripts, tasks, and backend runs
  --resume ID                Resume context; implies --keep-history
Requires POSIX and Lectic with --no-macros support.
Tools and permissions come from your Lectic configuration.
Opening the private URL starts a paid session after microphone permission.`)
    return
  }
  const options = parseArgs(args)
  const key = process.env["OPENAI_API_KEY"]
  if (!key) throw new Error("Set OPENAI_API_KEY to an OpenAI project API key")
  const previousSession = options.resume
    ? loadHistory(options.resume) : undefined
  if (process.platform === "win32") {
    throw new Error("Lectic Live requires POSIX process groups")
  }
  const cwd = process.cwd()
  const runOptions = {
    cwd, seed: resolve(options.seed),
    // Keep existing user-configured sandbox profiles working.
    env: { ...process.env, LECTIC_LIVE_WORKSPACE: cwd },
    timeoutMs: options.backendTimeout * 1000,
  }
  const history = options.keepHistory ? new History({
    seed: runOptions.seed, cwd, resumedFrom: options.resume,
  }) : undefined
  if (history) {
    console.log(`Local history: ${history.dir}`)
    console.log(`Resume later with --resume ${history.id}`)
  }
  if (previousSession) {
    console.log("Loaded saved conversation context. Opening the URL "
      + "creates a new Live session; no pending work is restarted.")
  }
  const server = startServer({
    ...options, history, previousSession,
    connect: liveConnector(key, options.voice),
    backend: async (context, signal) => {
      return runLectic(context, {
        ...runOptions, signal,
        historyDir: history ? join(history.dir, "runs") : undefined,
      })
    },
  })
  console.log("Lectic Live — private local URL (do not share):")
  console.log(server.url)
  console.log("Opening the URL starts a billable session automatically.")
  console.log("Close the tab to end; Ctrl-C also stops the local controller.")
  if (!options.noOpen) {
    const opener = Bun.which("xdg-open")
    if (opener) {
      const child = Bun.spawn([opener, server.url], {
        stdout: "ignore", stderr: "ignore",
      })
      void child.exited.catch(() => {})
    }
  }
  // lectic script exits when default() returns, even if Bun has a listener.
  await new Promise<void>(resolve => {
    let stopping = false
    const stop = () => {
      if (stopping) return
      stopping = true
      void server.stop().finally(() => {
        process.removeListener("SIGINT", stop)
        process.removeListener("SIGTERM", stop)
        resolve()
      })
    }
    process.on("SIGINT", stop)
    process.on("SIGTERM", stop)
  })
}
