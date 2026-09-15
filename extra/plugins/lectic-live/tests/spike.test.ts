import { expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { replaySpike } from "../spike"
import { runChild } from "../lectic-runner"
import { fakeCommand, realCommand, workspace } from "./helpers"
import events from "./fixtures/events.json"

const encoded = events.map(e => JSON.stringify(e))

test("delegation runs real CLI processing with fake provider; seed unchanged",
  async () => {
    const ws = await workspace()
    try {
      const capture = join(ws.dir, "capture.json")
      const results = await replaySpike([
        ...encoded, encoded.at(-1)!,
      ], "session-spike", {
        ...ws, command: fakeCommand,
        env: { ...ws.env, SPIKE_CAPTURE: capture },
      })
      expect(results).toEqual([{
        delegationId: "opaque/id:☃",
        result: { status: "completed", summary: "The answer is 42." },
      }])
      expect(await readFile(ws.seed, "utf8")).toBe(ws.source)
      const seen = JSON.parse(await readFile(capture, "utf8"))
      expect(seen.cwd).toBe(ws.cwd)
      expect(seen.prompt).toBe("Workspace-relative prompt")
      expect(seen.model).toBe("deterministic-spike")
      expect(seen.messages[0].content).toContain(":danger[]")
      expect(seen.messages[0].content).toContain(":fetch[./attachment.txt]")
      expect(seen.messages[0].content).toContain(":env[LECTIC_FILE]")
      expect(seen.messages[0].content).toContain('"text":"What is"')
      expect(seen.messages[0].content).toContain('"text":" the answer?"')
      expect(seen.messages[0].content).toContain('"speaker":"assistant"')
    } finally { await ws.cleanup() }
  }, 15_000)

test("conversation alone never launches a backend", async () => {
  expect(await replaySpike(encoded.slice(0, 3), "s", {
    seed: "/must/not/be/read", cwd: "/", command: ["missing-lectic"],
  })).toEqual([])
})

test("missing context and non-client delegations never launch", async () => {
  await expect(replaySpike(encoded.slice(3), "s", {
    seed: "/must/not/be/read", cwd: "/",
  })).rejects.toThrow("clarification")
  const nonClient = {
    ...events[3],
    delegation: { ...events[3]!.delegation, target: "responses" },
  }
  expect(await replaySpike([JSON.stringify(nonClient)], "s", {
    seed: "/must/not/be/read", cwd: "/",
  })).toEqual([])
})

for (const mode of ["throw", "zero-error", "malformed"]) {
  test(`backend ${mode} cannot become a successful result`, async () => {
    const ws = await workspace()
    try {
      await expect(replaySpike(encoded, "s", {
        ...ws, command: fakeCommand, env: { ...ws.env, SPIKE_MODE: mode },
      })).rejects.toThrow()
      expect(await readFile(ws.seed, "utf8")).toBe(ws.source)
    } finally { await ws.cleanup() }
  }, 15_000)
}

test("real CLI parse works with a managed record on stdin at seed base",
  async () => {
    const ws = await workspace()
    try {
      const result = JSON.parse(await runChild({
        command: realCommand, args: ["parse"], input: ws.source,
        cwd: join(ws.cwd, "docs"), env: ws.env,
      }))
      expect(result.messages[0].role).toBe("user")
    } finally { await ws.cleanup() }
  }, 15_000)
