#!/usr/bin/env -S lectic script
import { join, resolve } from "node:path"
import { History, loadHistory } from "./history"
import { backendPrompt } from "./prompts"
import { resolveLectic, runLectic } from "./lectic-runner"
import { liveConnector } from "./session"
import { openAIProvider } from "./openai"
import { startServer } from "./server"
import { geminiConnector } from "./gemini"
import { launchController } from "./launcher"

export function parseArgs(args: string[]) {
  const result = {
    model: "gpt-live-1",
    seed: "", noOpen: false, port: 0, voice: undefined as string | undefined,
    maxSessionSeconds: 600, backendTimeout: 120, contextSeconds: 300,
    idleTimeout: 30,
    keepHistory: false, resume: undefined as string | undefined,
  }
  for (let n = 0; n < args.length; n++) {
    const arg = args[n]
    if (arg === "--no-open") { result.noOpen = true; continue }
    if (arg === "--keep-history") { result.keepHistory = true; continue }
    if (!["-f", "--model", "--port", "--voice", "--max-session-seconds",
      "--backend-timeout", "--context-seconds", "--idle-timeout", "--resume",
    ].includes(arg)) {
      throw new Error(`Unknown option: ${arg}`)
    }
    const value = args[++n]
    if (!value || value.startsWith("--")) {
      throw new Error(`Missing value for ${arg}`)
    }
    if (arg === "-f") result.seed = value
    else if (arg === "--model") result.model = value
    else if (arg === "--resume") {
      if (!/^[a-f0-9-]{36}$/.test(value)) {
        throw new Error("Invalid history ID")
      }
      result.resume = value
      result.keepHistory = true
    } else if (arg === "--voice") {
      if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(value)) {
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
  if (!["gpt-live-1", "gemini-3.8-live"].includes(result.model)) {
    throw new Error(`Unsupported Live model: ${result.model}`)
  }
  if (result.voice && !(result.model === "gpt-live-1"
    ? /^[a-z][a-z0-9_-]{0,63}$/ : /^[A-Z][A-Za-z0-9_-]{0,63}$/
  ).test(result.voice)) throw new Error("Invalid provider voice name")
  if (result.model === "gemini-3.8-live" && result.resume) {
    throw new Error("Gemini resume is not enabled yet")
  }
  if (!result.seed) throw new Error("Required: -f ./voice-backend.lec")
  return result
}

export default async function main() {
  const args = process.argv.slice(2)
  const controller = args[0] === "--controller"
  if (controller) args.shift()
  if (args.length === 1 && args[0] === "--spike-info") {
    console.log(JSON.stringify({
      stage: 3, executable: resolveLectic(), backendPrompt,
    }))
    return
  }
  if (!args.length || (args.length === 1 && args[0] === "--help")) {
    console.log(`lectic live -f ./voice-backend.lec [options]
  --no-open                 Compatibility option; browser never auto-opens
  --port N                  Loopback port (default: automatic)
  --model NAME              gpt-live-1 (default) or gemini-3.8-live
  --voice NAME              Voice chosen at session creation
  --max-session-seconds N    Voice time budget (default: 600, max: 3600)
  --idle-timeout N           Idle disconnect (default: 30 seconds)
  --backend-timeout N        Backend phase timeout (default: 120 seconds)
  --context-seconds N        Recent context window (default: 300 seconds)
  --keep-history             Save local transcripts, tasks, and backend runs
  --resume ID                Resume context; implies --keep-history
Gemini supports delegation and microphone wake; CLI resume is not enabled.
Gemini time limits are elapsed connection time, not strict spending caps.
Requires POSIX and Lectic with --no-macros support.
Tools and permissions come from your Lectic configuration.
Prints only the private URL to stdout; diagnostics go to stderr.
Redirected stdout starts a background controller for shell substitution.
Closing the tab stops the controller (heartbeat fallback: 10 seconds).
Opening the private URL starts a paid session after microphone permission.`)
    return
  }
  const options = parseArgs(args)
  const gemini = options.model === "gemini-3.8-live"
  const credential = gemini ? "GEMINI_API_KEY" : "OPENAI_API_KEY"
  const key = process.env[credential]
  if (!key) throw new Error(`Set ${credential} for the chosen voice provider`)
  const previousSession = options.resume
    ? loadHistory(options.resume) : undefined
  if (process.platform === "win32") {
    throw new Error("Lectic Live requires POSIX process groups")
  }
  if (!controller && !process.stdout.isTTY) {
    console.log(await launchController(resolveLectic(), [
      "script", process.argv[1], "--controller", ...args,
    ]))
    return
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
    console.error(`Local history: ${history.dir}`)
    if (gemini) console.error("Gemini text is saved; Gemini resume is not "
      + "enabled yet.")
    else console.error(`Resume later with --resume ${history.id}`)
  }
  if (previousSession) {
    console.error("Loaded saved conversation context. Opening the URL "
      + "creates a new Live session; no pending work is restarted.")
  }
  const server = startServer({
    ...options, history, previousSession,
    provider: gemini ? "gemini" : "openai",
    connect: gemini ? geminiConnector(key, options.voice)
      : openAIProvider(liveConnector(key, options.voice)),
    backend: async (context, signal) => {
      return runLectic(context, {
        ...runOptions, signal,
        historyDir: history ? join(history.dir, "runs") : undefined,
      })
    },
  })
  // lectic script exits when default() returns, even with a Bun listener.
  const stop = () => {
    void server.stop().catch(() => {
      console.error("lectic live: controller cleanup failed")
    })
  }
  process.on("SIGINT", stop)
  process.on("SIGTERM", stop)
  try {
    console.error("Lectic Live — private local URL (do not share).")
    console.error("Opening it starts a billable session automatically.")
    console.error("Close the tab to stop the controller; "
      + (controller ? `background PID: ${process.pid}`
        : "Ctrl-C also stops it."))
    console.log(server.url)
    await server.stopped
  } finally {
    process.removeListener("SIGINT", stop)
    process.removeListener("SIGTERM", stop)
    await server.stop()
  }
}
