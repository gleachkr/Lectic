import { expect, test } from "bun:test"
import { Coordinator } from "./openai-fixture"
import type { LiveEvent } from "../protocol"
import { BackendFailure } from "../lectic-runner"

const speech = (delta: string): LiveEvent => ({
  type: "session.input_transcript.delta", delta, start_ms: 0, end_ms: 100,
})
const delegation = (id = "d1"): LiveEvent => ({
  type: "session.delegation.created", offset_ms: 100,
  delegation: { id, type: "delegation", target: "client" },
})

test("greetings do not run; late speech settles; duplicates run once",
  async () => {
    const contexts: any[] = []
    const delivered: string[] = []
    const c = new Coordinator("session", async context => {
      contexts.push(context)
      return { status: "completed", summary: "Found src/main.ts" }
    }, async (_id, summary) => { delivered.push(summary) }, 10)
    c.receive(speech("Hello "))
    expect(c.runs).toBe(0)
    c.receive(delegation())
    c.receive(delegation())
    c.receive(speech("inspect the entry point"))
    await c.idle()
    expect(contexts).toHaveLength(1)
    expect(contexts[0].fragments.map((f: any) => f.text)).toEqual([
      "Hello ", "inspect the entry point",
    ])
    expect(delivered).toEqual(["Found src/main.ts"])
    c.receive(delegation("d2"))
    await c.idle()
    expect(contexts[1].backendHistory).toHaveLength(1)
  })

test("insufficient context clarifies without launching Lectic", async () => {
  const delivered: string[] = []
  const c = new Coordinator("s", async () => {
    throw new Error("must not run")
  }, async (_id, text) => { delivered.push(text) }, 1)
  c.receive(delegation())
  await c.idle()
  expect(c.runs).toBe(0)
  expect(delivered[0]).toContain("clarify")
})

test("new speech withholds stale results; cancellation signals active work",
  async () => {
    let release: (() => void) | undefined
    let signal: AbortSignal | undefined
    let delivered = 0
    const c = new Coordinator("s", async (_context, s) => {
      signal = s
      await new Promise<void>(resolve => { release = resolve })
      return { status: "completed", summary: "old result" }
    }, async () => { delivered++ }, 1)
    c.receive(speech("inspect A"))
    c.receive(delegation())
    while (!release) await Bun.sleep(1)
    c.receive(speech("Actually B"))
    release()
    await c.idle()
    expect(delivered).toBe(0)
    expect(c.status).toContain("withheld")
    release = undefined
    c.receive(delegation("d2"))
    while (!release) await Bun.sleep(1)
    c.cancel()
    expect(signal!.aborted).toBe(true)
    ;(release as () => void)()
    await c.idle()
    expect(delivered).toBe(0)
  })

test("serialized queue never retries delivery failures", async () => {
  let active = 0
  let max = 0
  let sends = 0
  const c = new Coordinator("s", async () => {
    max = Math.max(max, ++active)
    await Bun.sleep(5)
    active--
    return { status: "completed", summary: "result" }
  }, async () => { sends++; throw new Error("lost ack") }, 1)
  c.receive(speech("inspect"))
  c.receive(delegation())
  c.receive(delegation("d2"))
  await c.idle()
  expect(max).toBe(1)
  expect(c.runs).toBe(2)
  expect(sends).toBe(1)
  expect(c.status).toContain("uncertain")
})

const until = async (condition: () => boolean) => {
  const deadline = Date.now() + 2000
  while (!condition() && Date.now() < deadline) await Bun.sleep(1)
  expect(condition()).toBe(true)
}

test("corrections reconcile request-scoped findings on the next delegation",
  async () => {
    let release: (() => void) | undefined
    let cancelled = false
    const contexts: any[] = []
    const lookups: string[] = []
    const delivered: string[] = []
    const c = new Coordinator("s", async (context, signal) => {
      contexts.push(context)
      signal.addEventListener("abort", () => { cancelled = true })
      if (!context.backendHistory?.length) {
        lookups.push("A")
        await new Promise<void>(resolve => { release = resolve })
        return { status: "completed", summary: "A lives in a.ts" }
      }
      // Deterministic backend models reconciliation, not another lookup A.
      const previous = context.backendHistory[0]
      expect(previous.status).toBe("completed")
      expect(previous.delivery).toBe("withheld")
      expect(previous.reason).toBe("new_delegation")
      expect(previous.requestContext).toContain("inspect A")
      expect(previous.requestContext).not.toContain("Actually B")
      expect(previous.summary).toBe("A lives in a.ts")
      lookups.push("B")
      return { status: "completed", summary: "B lives in b.ts" }
    }, async (_id, summary) => { delivered.push(summary) }, 1)
    c.receive(speech("inspect A"))
    c.receive(delegation())
    await until(() => !!release)
    c.receive(speech("Actually B, not A"))
    expect(c.runs).toBe(1)
    expect(cancelled).toBe(false)
    c.receive(delegation("d2"))
    release!()
    await c.idle()
    expect(lookups).toEqual(["A", "B"])
    expect(delivered).toEqual(["B lives in b.ts"])
    expect(contexts[1].taskRevision).toBeGreaterThan(contexts[0].taskRevision)
    expect(contexts[1].contextRevision)
      .toBeGreaterThan(contexts[0].contextRevision)
    expect(contexts[1].runId).not.toBe(contexts[0].runId)
    c.receive(delegation())
    expect(c.runs).toBe(2)
  })

test("duplicate and overlapping fragments preserve receipt sequence",
  async () => {
    const contexts: any[] = []
    const c = new Coordinator("s", async context => {
      contexts.push(context)
      return { status: "completed", summary: "done" }
    }, async () => {}, 1)
    const a: LiveEvent = {
      type: "session.input_transcript.delta", event_id: "a",
      delta: " inspect ", start_ms: 0, end_ms: 100,
    }
    c.receive(a)
    c.receive(a)
    c.receive({ ...a, event_id: "b" })
    c.receive({ ...a, event_id: "c",
      type: "session.output_transcript.delta", delta: "okay" })
    c.receive(delegation())
    await c.idle()
    expect(contexts[0].fragments.map((f: any) => f.sequence))
      .toEqual([1, 2, 3])
    expect(contexts[0].fragments.map((f: any) => f.text))
      .toEqual([" inspect ", " inspect ", "okay"])
  })

test("backchannels do not cancel or restart; late changes withhold output",
  async () => {
    let release: (() => void) | undefined
    let signal: AbortSignal | undefined
    let delivered = 0
    const c = new Coordinator("s", async (_context, s) => {
      signal = s
      await new Promise<void>(resolve => { release = resolve })
      return { status: "completed", summary: "finding" }
    }, async () => { delivered++ }, 1)
    c.receive(speech("inspect A"))
    c.receive(delegation())
    await until(() => !!release)
    c.receive(speech("mm-hmm"))
    expect(signal!.aborted).toBe(false)
    release!()
    await c.idle()
    expect(c.runs).toBe(1)
    expect(delivered).toBe(0)
    expect(c.diagnostics()[0]).toMatchObject({
      outcome: "completed", delivery: "withheld", reason: "context_changed",
    })
  })

test("queue saturation retains tombstones and expired tasks never execute",
  async () => {
    let now = 0
    let release: (() => void) | undefined
    const c = new Coordinator("s", async () => {
      await new Promise<void>(resolve => { release = resolve })
      return { status: "completed", summary: "finding" }
    }, async () => {}, { settleMs: 1, queueMs: 10, now: () => now })
    c.receive(speech("inspect A"))
    c.receive(delegation())
    await until(() => !!release)
    for (let n = 2; n <= 6; n++) c.receive(delegation(`d${n}`))
    expect(c.diagnostics().at(-1)?.outcome).toBe("rejected")
    now = 20
    release!()
    await c.idle()
    expect(c.runs).toBe(1)
    expect(c.diagnostics().filter(t => t.outcome === "expired"))
      .toHaveLength(4)
    c.receive(delegation("d6"))
    expect(c.runs).toBe(1)
  })

test("retention marks incomplete context without lockout; Clear keeps IDs",
  async () => {
    let now = 0
    const delivered: string[] = []
    const contexts: any[] = []
    const c = new Coordinator("s", async context => {
      contexts.push(context)
      return { status: "completed", summary: "finding" }
    }, async (_id, content) => { delivered.push(content) }, {
      settleMs: 1, contextSeconds: 1, now: () => now,
    })
    c.receive(speech("private old correction"))
    now = 2000
    c.receive(speech("short ambiguous reply"))
    c.receive(delegation())
    await c.idle()
    expect(c.runs).toBe(1)
    expect(contexts[0].contextIncomplete).toBe(true)
    expect(delivered[0]).toBe("finding")
    c.clearContext()
    c.receive(delegation())
    expect(c.runs).toBe(1)
    c.receive(speech("inspect B in full"))
    c.receive(delegation("d2"))
    await c.idle()
    expect(c.runs).toBe(2)
    expect(contexts[1].backendHistory).toEqual([])
    expect(contexts[1].contextIncomplete).toBe(false)
    expect(JSON.stringify(contexts[1])).not.toContain("private old")
    expect(contexts[1].fragments[0].sequence).toBe(3)
    expect(JSON.stringify(c.diagnostics())).not.toContain("inspect")
    expect(JSON.stringify(c.journal.snapshot())).not.toContain("private")
  })

test("oversized fragments cannot silently erase an unresolved correction",
  async () => {
    const sent: string[] = []
    const c = new Coordinator("s", async context => {
      expect(context.contextIncomplete).toBe(true)
      expect(context.fragments.map(f => f.text)).toEqual(["go ahead"])
      return { status: "clarification", summary: "Context is incomplete" }
    }, async (_id, text) => { sent.push(text) }, 1)
    c.receive(speech("Actually not the production server"))
    c.receive(speech("x".repeat(20_000)))
    c.receive(speech("go ahead"))
    c.receive(delegation())
    await c.idle()
    expect(c.runs).toBe(1)
    expect(sent[0]).toContain("incomplete")
  })

test("late acknowledgment records delivery but cannot undo cancellation",
  async () => {
    let acknowledge: (() => void) | undefined
    const c = new Coordinator("s", async () => ({
      status: "completed", summary: "finding",
    }), () => new Promise<void>(resolve => { acknowledge = resolve }), 1)
    c.receive(speech("inspect"))
    c.receive(delegation())
    await until(() => !!acknowledge)
    c.cancel()
    acknowledge!()
    await c.idle()
    expect(c.status).toContain("cancelled")
    expect(c.diagnostics()[0]).toMatchObject({
      outcome: "completed", delivery: "acknowledged",
    })
  })

test("clear and stop discard late completions without replay in a new owner",
  async () => {
    let release: (() => void) | undefined
    let sends = 0
    const c = new Coordinator("old", async () => {
      await new Promise<void>(resolve => { release = resolve })
      return { status: "completed", summary: "private old finding" }
    }, async () => { sends++ }, 1)
    c.receive(speech("old private request"))
    c.receive(delegation())
    await until(() => !!release)
    c.clearContext()
    c.stop()
    const next = new Coordinator("new", async context => {
      expect(context.sessionId).toBe("new")
      expect(context.backendHistory).toEqual([])
      expect(context.conversationId).not.toBe(c.journal.conversationId)
      return { status: "completed", summary: "new result" }
    }, async () => { sends++ }, 1)
    next.receive(speech("new request"))
    next.receive(delegation())
    release!()
    await Promise.all([c.idle(), next.idle()])
    expect(sends).toBe(1)
    expect(c.diagnostics()[0]).toMatchObject({
      outcome: "cancelled", delivery: "not_sent",
    })
    c.receive(delegation("d2"))
    expect(c.runs).toBe(1)
  })

test("cancel interrupts settling immediately and cancels queued requests",
  async () => {
    const c = new Coordinator("s", async () => {
      throw new Error("must not run")
    }, async () => {}, { settleMs: 10_000 })
    c.receive(speech("inspect"))
    c.receive(delegation())
    c.receive(delegation("d2"))
    c.cancel()
    await c.idle()
    expect(c.runs).toBe(0)
    expect(c.diagnostics().every(t => t.outcome === "cancelled")).toBe(true)
  })

test("retained findings and unresolved history are bounded", async () => {
  const contexts: any[] = []
  const c = new Coordinator("s", async context => {
    contexts.push(context)
    return { status: "completed", summary: "a".repeat(400) }
  }, async () => {}, 1)
  c.receive(speech("😀".repeat(800)))
  for (let n = 0; n < 12; n++) {
    c.receive(delegation(`d${n}`))
    await c.idle()
  }
  expect(c.runs).toBe(12)
  expect(contexts.at(-1).backendHistory).toHaveLength(8)
  expect(Buffer.byteLength(JSON.stringify(contexts.at(-1))))
    .toBeLessThan(32 * 1024)
  expect(contexts.at(-1).backendHistory[0].requestContext)
    .toContain("truncated")
})

test("cancelled runs remain uncertain context, never automatic retries",
  async () => {
    const contexts: any[] = []
    const c = new Coordinator("s", async (context, signal) => {
      contexts.push(context)
      if (contexts.length === 1) {
        await new Promise<void>(resolve => {
          signal.addEventListener("abort", () => resolve(), { once: true })
        })
        throw new Error("cancelled after possible write")
      }
      return { status: "completed", summary: "Checked actual state." }
    }, async () => {}, 1)
    c.receive(speech("Write A"))
    c.receive(delegation())
    await until(() => contexts.length === 1)
    c.cancel()
    await c.idle()
    expect(c.runs).toBe(1)
    expect(c.status).toContain("actions may already have happened")
    expect(c.historyContext().tasks[0].outcome).toBe("cancelled")
    c.receive(speech("Check whether A was written"))
    c.receive(delegation("d2"))
    await c.idle()
    expect(contexts[1].backendHistory[0]).toMatchObject({
      outcome: "cancelled", delivery: "not_sent",
      runId: contexts[0].runId,
    })
    expect(contexts[1].backendHistory[0].requestContext).toContain("Write A")
    expect(contexts[1].backendHistory[0].summary)
      .toContain("Check actual state before retrying")
  })

test("child failure reports a safe reason locally and to the voice model",
  async () => {
    const secret = "https://example.test/?key=private-secret"
    const delivered: string[] = []
    const logged: string[] = []
    const original = console.error
    console.error = (...args) => { logged.push(args.join(" ")) }
    try {
      const c = new Coordinator("s", async () => {
        throw new BackendFailure("exit", `Backend child failed: ${secret}`, 9)
      }, async (_id, summary) => { delivered.push(summary) }, 0)
      c.receive(speech("inspect"))
      c.receive(delegation())
      await c.idle()
      expect(logged).toHaveLength(1)
      expect(logged[0]).toContain("backend task 1 failed: "
        + "backend process exited with code 9")
      expect(delivered[0]).toContain("backend process exited with code 9")
      expect(delivered[0]).toContain("check actual state before retrying")
      expect(logged.join(" ") + delivered.join(" ")).not.toContain(secret)
    } finally { console.error = original }
  })

test("backend errors notify the voice model and allow later requests",
  async () => {
    const delivered: string[] = []
    let fail = true
    const c = new Coordinator("s", async () => {
      if (fail) throw new Error("private backend diagnostic")
      return { status: "completed", summary: "Recovered" }
    }, async (_id, summary) => { delivered.push(summary) }, 0)
    c.receive(speech("inspect the workspace"))
    c.receive(delegation("failure"))
    await c.idle()
    expect(delivered).toHaveLength(1)
    expect(delivered[0]).toContain("backend encountered an error")
    expect(delivered[0]).toContain("Actions may already have happened")
    expect(delivered[0]).not.toContain("private backend diagnostic")
    expect(c.diagnostics()[0]).toMatchObject({ outcome: "failed",
      delivery: "acknowledged" })
    fail = false
    c.receive(delegation("recovery"))
    await c.idle()
    expect(delivered[1]).toBe("Recovered")
    expect(c.runs).toBe(2)
  })
