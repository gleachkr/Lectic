#!/usr/bin/env bun
import { access } from "node:fs/promises"
import { resolve } from "node:path"
import { resolveLectic } from "../lectic-runner"
import { realBackend } from "./backend"
import { startHarness, type ProviderSocket } from "./server"

export function parseOptions(args: string[]) {
  let paid = false
  let real = false
  let history = false
  let seed: string | undefined
  const seen = new Set<string>()
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (seen.has(arg)) throw new Error("Duplicate option")
    seen.add(arg)
    switch (arg) {
      case "--allow-paid": paid = true; break
      case "--real-once": real = true; break
      case "--history": history = true; break
      case "-f":
        seed = args[++i]
        if (!seed || seed.startsWith("-")) throw new Error("Missing seed")
        break
      default: throw new Error("Unknown option")
    }
  }
  if (!paid) throw new Error("Explicit --allow-paid is required")
  if (real !== !!seed) {
    throw new Error("--real-once requires -f, and vice versa")
  }
  return { real, history, seed }
}

export async function buildAssets() {
  async function build(name: string) {
    const result = await Bun.build({
      entrypoints: [resolve(import.meta.dir, `${name}.ts`)],
      target: "browser", format: "iife", minify: false,
    })
    if (!result.success || result.outputs.length !== 1) {
      throw new Error("Could not build spike browser assets")
    }
    return result.outputs[0].text()
  }
  return { browser: await build("browser"), worklet: await build("worklet") }
}

async function main() {
  if (process.argv.slice(2).includes("--help")) {
    console.log(`Isolated Gemini stage 1 spike (not lectic live).
Usage: bun extra/plugins/lectic-live/gemini-spike/main.ts --allow-paid
Optional: --history (synthetic old conversation)
Optional: --real-once -f /path/to/backend.lec (one approved real request)
Requires GEMINI_API_KEY. Open the private URL, then click Start.
Default: 20-second fake work, five-minute connection cap, no retry.
No audio recording. Review GEMINI_SPIKE.md before paid testing.`)
    return
  }
  const options = parseOptions(process.argv.slice(2))
  const assets = await buildAssets()
  let real: ReturnType<typeof realBackend> | undefined
  if (options.real) {
    const seed = resolve(options.seed!)
    await access(seed)
    real = realBackend({ seed, cwd: process.cwd(), command: resolveLectic() })
  }
  // Credential lookup and connection are absent from fixture/test imports.
  const key = process.env["GEMINI_API_KEY"]
  if (!key) throw new Error("GEMINI_API_KEY is required")
  const harness = startHarness({
    assets, history: options.history, real,
    connect() {
      const endpoint = "wss://generativelanguage.googleapis.com/ws/"
        + "google.ai.generativelanguage.v1alpha."
        + "GenerativeService.BidiGenerateContent"
      const url = `${endpoint}?key=${encodeURIComponent(key)}`
      const socket = new WebSocket(url)
      socket.binaryType = "arraybuffer"
      return socket as unknown as ProviderSocket
    },
  })
  console.log(`Private Gemini spike URL (do not share):\n${harness.url}`)
  console.log(options.real
    ? "Real mode: one specific request must be approved in the browser."
    : "Fake mode: delegate simulates work for 20 seconds.")
  console.log("No paid connection until Start. Ctrl-C stops the controller.")
  let stopping = false
  const stop = () => {
    if (stopping) return
    stopping = true
    void harness.stop().then(() => process.exit(0))
  }
  process.on("SIGINT", stop)
  process.on("SIGTERM", stop)
}

if (import.meta.main) {
  main().catch(() => {
    // Never reflect raw provider URLs, filesystem errors, or credentials.
    console.error("Gemini spike failed. Check --help, GEMINI_API_KEY, "
      + "and the seed/lectic executable when using --real-once.")
    process.exitCode = 1
  })
}
