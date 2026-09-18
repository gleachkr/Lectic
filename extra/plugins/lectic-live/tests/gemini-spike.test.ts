import { expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { runInNewContext } from "node:vm"
import { buildAssets, parseOptions } from "../gemini-spike/main"
import { realBackend } from "../gemini-spike/backend"
import { fakeCommand, workspace } from "./helpers"

test("paid spike startup is explicit and rejects unsupported options", () => {
  expect(() => parseOptions([])).toThrow()
  expect(() => parseOptions(["--allow-paid", "--model", "gpt-live-1"]))
    .toThrow()
  expect(() => parseOptions(["--allow-paid", "--allow-paid"])).toThrow()
  expect(() => parseOptions(["--allow-paid", "--real-once"])).toThrow()
  expect(() => parseOptions(["--allow-paid", "-f", "seed.lec"])).toThrow()
  expect(() => parseOptions(["--allow-paid", "-f"])).toThrow()
  expect(parseOptions(["--allow-paid", "--history"]))
    .toEqual({ real: false, history: true, seed: undefined })
  expect(parseOptions(["--allow-paid", "--real-once", "-f", "seed.lec"]))
    .toEqual({ real: true, history: false, seed: "seed.lec" })
})

test("browser/worklet bundle without installs or runtime source imports",
  async () => {
    const assets = await buildAssets()
    expect(assets.browser).toContain("AudioWorkletNode")
    expect(assets.browser).not.toContain("GEMINI_API_KEY")
    expect(assets.worklet).toContain("registerProcessor")
    expect(assets.worklet).not.toMatch(/import .* from/)
    let Processor: any
    const messages: any[] = []
    runInNewContext(assets.worklet, {
      sampleRate: 44100,
      AudioWorkletProcessor: class {
        port = { postMessage: (value: unknown) => messages.push(value) }
      },
      registerProcessor(name: string, cls: any) {
        expect(name).toBe("lectic-pcm")
        Processor = cls
      },
    })
    const capture = new Processor()
    capture.process([[new Float32Array(882)]])
    expect(messages).toHaveLength(0)
    capture.port.onmessage({ data: "start" })
    for (let i = 0; i < 26; i++) {
      capture.process([[new Float32Array(882)]])
    }
    expect(messages).toHaveLength(26)
    expect(messages[0].byteLength).toBe(1764)
    expect(messages[25]).toEqual({ type: "overload" })
    capture.process([[new Float32Array(882)]])
    expect(messages).toHaveLength(26)
  })

test("explicit task reuses trusted Lectic runner with macros inert",
  async () => {
    const ws = await workspace()
    try {
      const capture = join(ws.dir, "capture.json")
      const backend = realBackend({ ...ws, command: fakeCommand,
        env: { ...ws.env, SPIKE_CAPTURE: capture } })
      const result = await backend("Check status. :danger[]",
        new AbortController().signal)
      expect(result).toBe("completed: The answer is 42.")
      expect(await readFile(ws.seed, "utf8")).toBe(ws.source)
      const seen = JSON.parse(await readFile(capture, "utf8"))
      expect(seen.cwd).toBe(ws.cwd)
      expect(seen.prompt).toBe("Workspace-relative prompt")
      expect(seen.messages[0].content).toContain('"spikeRequest":')
      expect(seen.messages[0].content).toContain('"fragments":[]')
      expect(seen.messages[0].content).toContain("Check status. :danger[]")
      expect(seen.messages[0].content).not.toContain("EXPANDED_UNSAFE")
    } finally { await ws.cleanup() }
  }, 15000)
