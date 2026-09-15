import { expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import { readFile, readdir, stat, writeFile } from "node:fs/promises"
import { join } from "node:path"
import {
  boundHistory, History, historyRoot, loadHistory, type HistoryContext,
} from "../history"
import { Coordinator } from "../coordinator"
import { parseArgs } from "../lectic-live"
import { replaySpike } from "../spike"
import { fakeCommand, workspace } from "./helpers"
import events from "./fixtures/events.json"

const saved = (): HistoryContext => ({
  version: 1, conversationId: randomUUID(), incomplete: false,
  fragments: [{ sessionId: "old", sequence: 0,
    speaker: "user", text: "inspect A" }],
  tasks: [{
    sessionId: "old", delegationId: "old-task", revision: 1, received: 0,
    outcome: "completed", delivery: "withheld", context: "inspect A",
    result: { status: "completed", summary: "A is in a.ts" },
  }, {
    sessionId: "old", delegationId: "unfinished", revision: 2, received: 1,
    outcome: "running", delivery: "pending",
  }],
})

test("history is opt-in; resume implies retention and requires an ID", () => {
  expect(parseArgs(["-f", "seed"]).keepHistory).toBe(false)
  expect(parseArgs(["-f", "seed", "--keep-history"]).keepHistory).toBe(true)
  const id = randomUUID()
  expect(parseArgs(["-f", "seed", "--resume", id])).toMatchObject({
    keepHistory: true, resume: id,
  })
  for (const args of [["--resume"], ["--resume", "../bad"]]) {
    expect(() => parseArgs(["-f", "seed", ...args])).toThrow()
  }
  expect(historyRoot({ LECTIC_STATE: "/state" })).toBe("/state/live")
  expect(historyRoot({ XDG_STATE_HOME: "/xdg" })).toBe("/xdg/lectic/live")
})

test("private archive retains content independently of bounded context",
  async () => {
    const ws = await workspace()
    try {
      const root = historyRoot(ws.env)
      const history = new History(ws, root)
      const context = saved()
      history.append("transcript", "old text kept in archive")
      history.checkpoint(context)
      expect(loadHistory(history.id, root)).toEqual(context)
      const cleared = { ...context, fragments: [], tasks: [] }
      history.checkpoint(cleared, true)
      expect(loadHistory(history.id, root)).toEqual(cleared)
      const log = await readFile(join(history.dir, "events.jsonl"), "utf8")
      expect(log).toContain("old text kept in archive")
      expect(log).toContain("A is in a.ts")
      expect((await stat(history.dir)).mode & 0o777).toBe(0o700)
      for (const file of await readdir(history.dir)) {
        expect((await stat(join(history.dir, file))).mode & 0o777).toBe(0o600)
      }
      await writeFile(join(history.dir, "context.json"), '{"version":2}')
      expect(() => loadHistory(history.id, root)).toThrow("format")
      await writeFile(join(history.dir, "context.json"), "x".repeat(8193))
      expect(() => loadHistory(history.id, root)).toThrow("limit")
      expect(() => loadHistory("../bad", root)).toThrow("ID")
      expect(() => loadHistory(randomUUID(), root)).toThrow()
    } finally { await ws.cleanup() }
  })

test("resume context stays bounded and marks omissions", () => {
  const original = saved()
  original.fragments.push({ sessionId: "old", sequence: 0, speaker: "user",
    text: "雪".repeat(10_000) })
  const bounded = boundHistory(original)
  expect(Buffer.byteLength(JSON.stringify(bounded))).toBeLessThanOrEqual(8192)
  expect(bounded.incomplete).toBe(true)
  expect(bounded.tasks).toHaveLength(2)
  expect(original.incomplete).toBe(false)
})

test("resume supplies prior findings only on new delegation; no work replay",
  async () => {
    const previous = saved()
    const seen: any[] = []
    const sends: string[] = []
    const c = new Coordinator("new", async context => {
      seen.push(context)
      return { status: "completed", summary: "Reused A finding" }
    }, async id => { sends.push(id) }, {
      settleMs: 1, previousSession: previous,
    })
    await c.idle()
    expect(c.runs).toBe(0)
    expect(sends).toEqual([])
    c.receive({ type: "session.input_transcript.delta",
      delta: "Where was A?", start_ms: 0, end_ms: 1 })
    expect(c.runs).toBe(0)
    c.receive({ type: "session.delegation.created", offset_ms: 1,
      delegation: { id: "new-task", type: "delegation", target: "client" } })
    await c.idle()
    expect(c.runs).toBe(1)
    expect(seen[0].previousSession).toEqual(previous)
    expect(seen[0].conversationId).toBe(previous.conversationId)
    expect(seen[0].sessionId).toBe("new")
    expect(seen[0].backendHistory).toEqual([])
    expect(sends).toEqual(["new-task"])
    expect(c.historyContext().tasks).toHaveLength(3)
    c.clearContext()
    expect(c.historyContext().fragments).toEqual([])
    expect(JSON.stringify(c.historyContext())).not.toContain("A is in a.ts")
  })

for (const mode of ["ok", "malformed", "throw"]) {
  test(`kept backend ${mode} records leave the seed unchanged`, async () => {
    const ws = await workspace()
    try {
      const historyDir = join(ws.dir, "runs")
      const run = replaySpike(events.map(e => JSON.stringify(e)), "s", {
        ...ws, command: fakeCommand, historyDir,
        env: { ...ws.env, SPIKE_MODE: mode },
      })
      if (mode === "ok") await run
      else await expect(run).rejects.toThrow()
      const dirs = await readdir(historyDir)
      expect(dirs).toHaveLength(1)
      const dir = join(historyDir, dirs[0])
      expect((await stat(dir)).mode & 0o777).toBe(0o700)
      const request = await readFile(join(dir, "request.json"), "utf8")
      expect(request).toContain("What is")
      if (mode !== "throw") {
        expect(await readFile(join(dir, "run.lec"), "utf8"))
          .toContain("Prior backend context")
      }
      if (mode !== "ok") {
        expect(await readFile(join(dir, "error.txt"), "utf8"))
          .not.toBeEmpty()
      }
      for (const file of await readdir(dir)) {
        expect((await stat(join(dir, file))).mode & 0o777).toBe(0o600)
      }
      expect(await readFile(ws.seed, "utf8")).toBe(ws.source)
    } finally { await ws.cleanup() }
  }, 15_000)
}

test("resume checkpoint outlives model-window eviction; Clear resets it",
  async () => {
    const ws = await workspace()
    try {
      const root = historyRoot(ws.env)
      const history = new History(ws, root)
      const original = saved()
      history.checkpoint(original)
      history.checkpoint({ ...original, fragments: [], tasks: [
        { ...original.tasks[0], context: undefined, result: undefined },
      ].map(({ context: _context, result: _result, ...task }) => task) })
      expect(loadHistory(history.id, root).fragments).toEqual(
        original.fragments,
      )
      const task = loadHistory(history.id, root).tasks.find(
        t => t.delegationId === "old-task",
      )
      expect(task?.result?.summary).toBe("A is in a.ts")
      history.checkpoint({ ...original, fragments: [], tasks: [] }, true)
      expect(loadHistory(history.id, root).fragments).toEqual([])
      expect(loadHistory(history.id, root).tasks).toEqual([])
    } finally { await ws.cleanup() }
  })

test("slow lookup findings persist even after their working window expires",
  async () => {
    const ws = await workspace()
    try {
      const root = historyRoot(ws.env)
      const history = new History(ws, root)
      let now = 0
      const c = new Coordinator("s", async () => {
        now = 2000
        return { status: "completed", summary: "Slow finding" }
      }, async () => {}, {
        settleMs: 1, contextSeconds: 1, now: () => now,
        changed: () => history.checkpoint(c.historyContext()),
      })
      c.receive({ type: "session.input_transcript.delta",
        delta: "inspect A", start_ms: 0, end_ms: 1 })
      c.receive({ type: "session.delegation.created", offset_ms: 1,
        delegation: { id: "d", type: "delegation", target: "client" } })
      await c.idle()
      expect(loadHistory(history.id, root).tasks[0].result?.summary)
        .toBe("Slow finding")
      expect(loadHistory(history.id, root).tasks[0].delivery)
        .toBe("acknowledged")
    } finally { await ws.cleanup() }
  })

test("resume leaves room for current speech and escaped request history",
  async () => {
    const previous = saved()
    previous.fragments[0].text = "x".repeat(7000)
    const seen: any[] = []
    const c = new Coordinator("new", async context => {
      seen.push(context)
      return { status: "completed", summary: '"'.repeat(400) }
    }, async () => {}, { settleMs: 1, previousSession: previous })
    c.receive({ type: "session.input_transcript.delta",
      delta: "\\".repeat(6000), start_ms: 0, end_ms: 1 })
    for (let n = 0; n < 6; n++) {
      c.receive({ type: "session.delegation.created", offset_ms: 1,
        delegation: { id: "d".repeat(1020) + n,
          type: "delegation", target: "client" } })
      await c.idle()
    }
    expect(c.runs).toBe(6)
    expect(seen.at(-1).contextIncomplete).toBe(true)
    expect(seen.at(-1).backendHistory.length).toBeLessThan(4)
    for (const context of seen) {
      expect(Buffer.byteLength(JSON.stringify(context)))
        .toBeLessThanOrEqual(32 * 1024)
    }
  })
