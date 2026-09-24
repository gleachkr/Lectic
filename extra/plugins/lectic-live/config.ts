import { open, mkdtemp, rm, writeFile } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { runChild, resolveLectic } from "./lectic-runner"
import { SessionFailure } from "./provider"

type LiveConfig = {
  model?: string
  voice?: string
  prompt?: string
}

const MAX_PROMPT_BYTES = 16 * 1024
const MAX_SOURCE_BYTES = 64 * 1024

export class LivePromptFailure extends SessionFailure {
  constructor(message: string) { super(message) }
}

function mapping(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
    && !Array.isArray(value)
}

export async function readLiveConfig(
  seed: string, cwd: string, command = resolveLectic(),
): Promise<LiveConfig> {
  // Use the public CLI rather than importing core sources: installed plugins
  // can be relocated independently of the Lectic source tree.
  let parsed: string
  try {
    parsed = await runChild({
      command, args: ["parse", "-f", seed,
        "--effective-header"], input: "", cwd,
      phase: "parse", timeoutMs: 10_000, maxBytes: 4 * 1024 * 1024,
    })
  } catch {
    // Parse diagnostics can quote private YAML values. Do not print them.
    throw new Error("Unable to parse effective Lectic header")
  }
  let header: unknown
  try { header = (JSON.parse(parsed) as { header: unknown }).header } catch {
    throw new Error("Unable to read effective Lectic configuration")
  }
  if (!mapping(header)) throw new Error("Invalid effective Lectic header")
  const live = header["live"]
  if (live === undefined) return {}
  if (!mapping(live)) throw new Error("live must be a mapping")
  for (const key of Object.keys(live)) {
    if (!["model", "voice", "prompt"].includes(key)) {
      throw new Error(`Unknown live option: ${key}`)
    }
    if (typeof live[key] !== "string") {
      throw new Error(`live.${key} must be a string`)
    }
  }
  const configuredModel = live["model"]
  if (configuredModel !== undefined
    && !["gpt-live-1", "gemini-3.8-live"].includes(configuredModel as string)) {
    throw new Error(`Unsupported live.model: ${configuredModel}`)
  }
  const configuredVoice = live["voice"]
  if (configuredVoice !== undefined
    && !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(configuredVoice as string)) {
    throw new Error("Invalid live.voice name")
  }
  const prompt = live["prompt"] as string | undefined
  if (prompt && Buffer.byteLength(prompt) > (prompt.startsWith("exec:")
    || prompt.startsWith("file:") ? MAX_SOURCE_BYTES : MAX_PROMPT_BYTES)) {
    throw new Error("live.prompt source exceeds size limit")
  }
  // The parse CLI exposes the effective header, but its document header
  // retains file:local: spelling. Imported sources are already rewritten.
  if (prompt?.startsWith("file:local:")) {
    const local = prompt.slice("file:local:".length)
    if (!local.startsWith("./") && !local.startsWith("../")) {
      throw new Error("live.prompt local path must start with ./ or ../")
    }
    return { ...live, prompt: `file:${resolve(dirname(seed), local)}` }
  }
  return live as LiveConfig
}

export function selectVoice(
  config: LiveConfig,
  cli: { model: string; voice?: string; explicit: Set<string> },
) {
  const model = cli.explicit.has("--model") ? cli.model
    : config.model ?? cli.model
  const voice = cli.explicit.has("--voice") ? cli.voice
    : config.voice ?? cli.voice
  if (!["gpt-live-1", "gemini-3.8-live"].includes(model)) {
    throw new Error(`Unsupported Live model: ${model}`)
  }
  if (voice !== undefined && !(model === "gpt-live-1"
    ? /^[a-z][a-z0-9_-]{0,63}$/ : /^[A-Z][A-Za-z0-9_-]{0,63}$/
  ).test(voice)) throw new Error("Invalid provider voice name")
  return { model, voice }
}

function promptEnv(seed: string, cwd: string): NodeJS.ProcessEnv {
  const home = homedir()
  const path = (name: string, xdg: string, fallback: string,
    mac: string) => process.env[name] ?? join(process.platform === "darwin"
    ? join(home, "Library", mac)
    : process.env[xdg] ?? join(home, fallback), "lectic")
  return {
    ...process.env,
    LECTIC_CONFIG: path("LECTIC_CONFIG", "XDG_CONFIG_HOME", ".config",
      "Preferences"),
    LECTIC_DATA: path("LECTIC_DATA", "XDG_DATA_HOME", ".local/share",
      "Application Support"),
    LECTIC_CACHE: path("LECTIC_CACHE", "XDG_CACHE_HOME", ".cache",
      "Caches"),
    LECTIC_STATE: path("LECTIC_STATE", "XDG_STATE_HOME", ".local/state",
      "Application Support"),
    LECTIC_TEMP: join(tmpdir(), "lectic"), LECTIC_FILE: seed,
    LECTIC_LIVE_WORKSPACE: cwd,
  }
}

function expandEnv(value: string, env: NodeJS.ProcessEnv) {
  return value.replace(/\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))/g,
    (match, braced: string, bare: string) => env[braced ?? bare] ?? match)
}

function commandArgs(value: string, env: NodeJS.ProcessEnv): string[] {
  // Same quoting and variable-expansion rules as Lectic's exec command.
  const args = value.match(/"[^"]*"|'[^']*'|\S+/g)?.map(part => {
    const unquoted = ((part.startsWith('"') && part.endsWith('"'))
      || (part.startsWith("'") && part.endsWith("'")))
      ? part.slice(1, -1) : part
    return expandEnv(unquoted, env)
  }) ?? []
  if (!args.length) throw new LivePromptFailure("live.prompt exec is empty")
  return args
}

export async function resolveLivePrompt(
  source: string | undefined, seed: string, cwd: string,
  signal?: AbortSignal,
): Promise<string | undefined> {
  if (source === undefined) return undefined
  const env = promptEnv(seed, cwd)
  let output = source
  try {
    if (source.startsWith("file:")) {
      const filename = expandEnv(source.slice(5).trim(), env)
      if (!filename) throw new Error("Empty file path")
      const path = resolve(cwd, filename)
      const file = await open(path, "r")
      try {
        const buffer = Buffer.alloc(MAX_PROMPT_BYTES + 1)
        let size = 0
        while (size < buffer.length) {
          const { bytesRead } = await file.read(buffer, size,
            buffer.length - size, size)
          if (!bytesRead) break
          size += bytesRead
        }
        if (size > MAX_PROMPT_BYTES) throw new Error("File exceeds limit")
        output = buffer.subarray(0, size).toString("utf8")
      } finally { await file.close() }
    } else if (source.startsWith("exec:")) {
      const command = source.slice(5).trim()
      if (!command) throw new Error("Empty command")
      let args: string[]
      let dir: string | undefined
      try {
        if (command.includes("\n")) {
          if (!command.startsWith("#!")) throw new Error("Missing shebang")
          dir = await mkdtemp(join(tmpdir(), "lectic-live-prompt-"))
          const script = join(dir, "prompt")
          await writeFile(script, command, { mode: 0o700 })
          args = [...command.slice(2).split("\n")[0].trim().split(" "), script]
        } else args = commandArgs(command, env)
        output = await runChild({ command: args, args: [], input: "", cwd,
          env, signal, timeoutMs: 5_000, maxBytes: MAX_PROMPT_BYTES })
      } finally {
        if (dir) await rm(dir, { recursive: true, force: true })
      }
    }
    if (Buffer.byteLength(output) > MAX_PROMPT_BYTES) {
      throw new Error("Output exceeds limit")
    }
  } catch {
    // Command stderr and output can contain secrets. Never echo them to the
    // browser or terminal; report only the source kind.
    throw new LivePromptFailure("Could not resolve live.prompt")
  }
  return output
}
