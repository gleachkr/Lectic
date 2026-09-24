import { expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { readLiveConfig, resolveLivePrompt, selectVoice } from "../config"
import { parseArgs } from "../lectic-live"
import { createRequest } from "../protocol"
import { geminiSetup } from "../gemini"
import { voicePrompt, geminiVoicePrompt } from "../prompts"

const cli = [process.execPath, resolve("src/main.ts")]

async function inWorkspace(run: (dir: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "live-config-test-"))
  try { await run(dir) } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

test("live mapping inherits config and doc overrides; flags win", async () => {
  await inWorkspace(async dir => {
    const seed = join(dir, "task.lec")
    await writeFile(join(dir, "lectic.yaml"),
      "live:\n  model: gemini-3.8-live\n  voice: Aoede\n")
    await writeFile(join(dir, "import.yaml"),
      "live:\n  prompt: file:local:./memory.txt\n")
    await writeFile(join(dir, "memory.txt"), "Imported memory")
    await writeFile(seed, `---
imports:
  - ./import.yaml
interlocutor:
  name: Assistant
  prompt: Backend only
live:
  voice: Kore
---
`)
    const config = await readLiveConfig(seed, dir, cli)
    expect(config.model).toBe("gemini-3.8-live")
    expect(selectVoice(config, parseArgs(["-f", seed]))).toEqual({
      model: "gemini-3.8-live", voice: "Kore",
    })
    expect(await resolveLivePrompt(config.prompt, seed, dir))
      .toBe("Imported memory")
    expect(selectVoice(config, parseArgs(["-f", seed,
      "--model", "gpt-live-1", "--voice", "marin"]))).toEqual({
      model: "gpt-live-1", voice: "marin",
    })
    expect(() => selectVoice(config, parseArgs(["-f", seed,
      "--model", "gpt-live-1"]))).toThrow("Invalid provider voice")
    await writeFile(seed, `---\ninterlocutor:\n  name: Assistant\n`
      + `  prompt: Backend\nlive:\n  prompt: file:local:./memory.txt\n---\n`)
    expect(await resolveLivePrompt((await readLiveConfig(seed, dir, cli)).prompt,
      seed, dir)).toBe("Imported memory")
  })
})

test("live config rejects bad types, unknown fields and malformed YAML",
  async () => {
    await inWorkspace(async dir => {
      const seed = join(dir, "task.lec")
      for (const [field, error] of [
        ["live: []", "live must be a mapping"],
        ["live:\n  prompt: 3", "live.prompt must be a string"],
        ["live:\n  vocie: marin", "Unknown live option: vocie"],
        ["live:\n  model: bogus", "Unsupported live.model"],
        ["live:\n  voice: ''", "Invalid live.voice"],
        ["live: [", "Unable to parse effective Lectic header"],
      ]) {
        await writeFile(seed, `---\ninterlocutor:\n  name: A\n`
          + `  prompt: Backend\n${field}\n---\n`)
        await expect(readLiveConfig(seed, dir, cli)).rejects.toThrow(error)
      }
    })
  }, 15_000)

test("exec prompt refreshes and is bounded before provider creation",
  async () => {
    await inWorkspace(async dir => {
      const seed = join(dir, "task.lec")
      const memory = join(dir, "memory.txt")
      await writeFile(memory, "first")
      const source = "exec:cat memory.txt"
      expect(await resolveLivePrompt(source, seed, dir)).toBe("first")
      await writeFile(memory, "second")
      expect(await resolveLivePrompt(source, seed, dir)).toBe("second")
      expect(await resolveLivePrompt("exec:printenv LECTIC_FILE", seed, dir))
        .toBe(`${seed}\n`)
      expect(await resolveLivePrompt("exec:#!/bin/sh\nprintf 'script'\n",
        seed, dir)).toBe("script")
      await expect(resolveLivePrompt("exec:false", seed, dir))
        .rejects.toThrow("Could not resolve live.prompt")
      await expect(resolveLivePrompt("exec:head -c 20000 /dev/zero",
        seed, dir)).rejects.toThrow("Could not resolve live.prompt")
    })
  })

test("both providers append supplement without replacing protocol", () => {
  const openai = createRequest("offer", undefined, [], "Current memory").session
  expect(openai.instructions).toBe(`${voicePrompt}\n\nCurrent memory`)
  const gemini = geminiSetup("Kore", "Current memory").setup
  expect(gemini.systemInstruction.parts[0].text)
    .toBe(`${geminiVoicePrompt}\n\nCurrent memory`)
})
