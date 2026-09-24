import { expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { runChild, runLectic, type RunOptions } from "../lectic-runner"
import { decodeEvent, type LiveEvent } from "../protocol"
import { Coordinator } from "./openai-fixture"
import { fakeCommand, realCommand, workspace } from "./helpers"
import events from "./fixtures/events.json"

const wire = events.map(event => decodeEvent(JSON.stringify(event))!)

function backendSession(options: RunOptions) {
  const results: unknown[] = []
  const delivered: { id: string; summary: string }[] = []
  const c = new Coordinator("s", async (context, signal) => {
    const result = await runLectic(context, { ...options, signal })
    results.push(result)
    return result
  }, async (id, summary) => { delivered.push({ id, summary }) }, 1)
  const receive = (input: LiveEvent[]) => input.forEach(event => c.receive(event))
  return { c, receive, results, delivered }
}

test("delegation runs real CLI processing; duplicates do not rerun it",
  async () => {
    const ws = await workspace()
    try {
      const capture = join(ws.dir, "capture.json")
      const session = backendSession({
        ...ws, command: fakeCommand,
        env: { ...ws.env, LIVE_TEST_CAPTURE: capture },
      })
      session.receive([...wire, wire.at(-1)!])
      await session.c.idle()
      expect(session.c.runs).toBe(1)
      expect(session.results).toEqual([
        { status: "completed", summary: "The answer is 42." },
      ])
      expect(session.delivered).toEqual([{
        id: "opaque/id:☃", summary: "The answer is 42.",
      }])
      expect(await readFile(ws.seed, "utf8")).toBe(ws.source)
      const seen = JSON.parse(await readFile(capture, "utf8"))
      expect(seen.cwd).toBe(ws.cwd)
      expect(seen.prompt).toBe("Workspace-relative prompt")
      expect(seen.model).toBe("deterministic-live")
      expect(seen.messages[0].content).toContain(":danger[]")
      expect(seen.messages[0].content).toContain(":fetch[./attachment.txt]")
      expect(seen.messages[0].content).toContain(":env[LECTIC_FILE]")
      expect(seen.messages[0].content).toContain('"text":"What is"')
      expect(seen.messages[0].content).toContain('"text":" the answer?"')
      expect(seen.messages[0].content).toContain('"speaker":"assistant"')
    } finally { await ws.cleanup() }
  }, 15_000)

test("real CLI returns plain text with a backslash and wrapped line",
  async () => {
    const ws = await workspace()
    try {
      const session = backendSession({
        ...ws, command: fakeCommand,
        env: { ...ws.env, LIVE_TEST_MODE: "backslashes" },
      })
      session.receive(wire)
      await session.c.idle()
      expect(session.results).toEqual([{
        status: "completed", summary: [
          "Listed src: constants, " + String.fromCharCode(92),
          "main.ts and tools.",
        ].join("\n"),
      }])
    } finally { await ws.cleanup() }
  }, 15_000)

test("conversation alone never launches a backend", async () => {
  const session = backendSession({
    seed: "/must/not/be/read", cwd: "/", command: ["missing-lectic"],
  })
  session.receive(wire.slice(0, 3))
  await session.c.idle()
  expect(session.c.runs).toBe(0)
  expect(session.delivered).toEqual([])
})

test("missing context clarifies; non-client delegations do not launch",
  async () => {
    const session = backendSession({
      seed: "/must/not/be/read", cwd: "/", command: ["missing-lectic"],
    })
    session.receive(wire.slice(3))
    await session.c.idle()
    expect(session.c.runs).toBe(0)
    expect(session.delivered[0]?.summary).toContain("clarify")
    const nonClient = { ...events[3], delegation: {
      ...events[3]!.delegation, target: "responses",
    } }
    const ignored = decodeEvent(JSON.stringify(nonClient))!
    session.receive([ignored])
    await session.c.idle()
    expect(session.c.runs).toBe(0)
  })

for (const mode of ["throw", "zero-error", "malformed"]) {
  test(`backend ${mode} cannot become a successful result`, async () => {
    const ws = await workspace()
    try {
      const session = backendSession({
        ...ws, command: fakeCommand,
        env: { ...ws.env, LIVE_TEST_MODE: mode },
      })
      session.receive(wire)
      await session.c.idle()
      expect(session.c.runs).toBe(1)
      expect(session.results).toEqual([])
      expect(session.delivered).toHaveLength(1)
      expect(session.delivered[0]?.summary).not.toContain("The answer is 42")
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
