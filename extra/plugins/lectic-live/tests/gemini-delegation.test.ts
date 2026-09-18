import { expect, test } from "bun:test"
import { Coordinator, type Backend, type CoordinatorOptions }
  from "../coordinator"
import { geminiConnector, type GeminiSocket } from "../gemini"
import { runChild } from "../lectic-runner"
import type { ContextEnvelope } from "../transcript"

const finding = { status: "completed" as const, summary: "A was written." }
async function until(check: () => boolean) {
  const deadline = Date.now() + 2000
  while (!check()) {
    if (Date.now() > deadline) throw new Error("Test wait expired")
    await Bun.sleep(1)
  }
}
async function harness(
  backend: Backend = async () => finding,
  options: CoordinatorOptions = {},
) {
  const wires: any[] = []
  const contexts: ContextEnvelope[] = []
  let losses = 0
  const socket: GeminiSocket = {
    readyState: 1, bufferedAmount: 0,
    send: raw => { wires.push(JSON.parse(raw)) },
    close: () => { socket.readyState = 3; socket.onclose?.() },
    onopen: null, onmessage: null, onerror: null, onclose: null,
  }
  const message = (value: unknown) => socket.onmessage?.({
    data: JSON.stringify(value),
  })
  const pending = geminiConnector("unused", undefined, () => socket)("",
    event => {
      if (event.type === "request" || event.type === "cancel"
        || event.type === "transcript") c.receive(event)
    }, () => { losses++; c.stop() }, new AbortController().signal)
  socket.onopen!()
  message({ setupComplete: {} })
  const session = await pending
  const c = new Coordinator(session.owner, async (context, signal) => {
    contexts.push(context)
    return backend(context, signal)
  }, session.complete, options)
  const call = (id = "a", task = "Write A once") => ({
    id, name: "delegate", args: { task },
  })
  const request = (id = "a", task = "Write A once") => message({
    toolCall: { functionCalls: [call(id, task)] },
  })
  return { socket, session, c, contexts, wires, message, call, request,
    cancel: (...ids: string[]) => message({ toolCallCancellation: { ids } }),
    speech: (text: string) => message({ serverContent: {
      inputTranscription: { text },
    } }),
    responses: () => wires.flatMap(w =>
      w.toolResponse?.functionResponses ?? []),
    losses: () => losses,
    async close() { await session.close(); c.stop(); await c.idle() },
  }
}

test("explicit task works without transcripts or the 750 ms heuristic",
  async () => {
    const h = await harness(undefined, { settleMs: 60_000 })
    try {
      h.speech("Hello")
      expect(h.c.runs).toBe(0)
      h.request()
      h.request("a", "duplicate ID with changed arguments")
      await until(() => h.responses().length === 1)
      await h.c.idle()
      expect(h.contexts).toHaveLength(1)
      expect(h.contexts[0].task).toBe("Write A once")
      expect(h.contexts[0].fragments[0].text).toBe("Hello")
      expect(h.responses()[0]).toEqual({ id: "a", name: "delegate",
        response: { result: "completed: A was written." },
        scheduling: "WHEN_IDLE", willContinue: false })
      expect(h.c.diagnostics()[0]).toMatchObject({
        outcome: "completed", delivery: "sent",
        resolution: { outcome: "completed", delivery: "sent" },
      })
      expect(h.wires.filter(w => w.clientContent)).toHaveLength(0)
    } finally { await h.close() }
  })

test("late unkeyed transcripts and backchannels do not stale explicit work",
  async () => {
    let release!: () => void
    const h = await harness(async () => {
      await new Promise<void>(done => { release = done })
      return finding
    })
    try {
      h.request()
      await until(() => !!release)
      // Could be the original request, not a new correction. No media time.
      h.speech("Write A once")
      h.speech(" mm-hmm")
      h.speech(" mm-hmm")
      expect(h.contexts[0].fragments).toEqual([])
      release()
      await h.c.idle()
      expect(h.responses()[0].response.result).toContain("A was written")
      expect(h.c.historyContext().fragments.map(f => f.text)).toEqual([
        "Write A once", " mm-hmm", " mm-hmm",
      ])
      expect(h.c.runs).toBe(1)
    } finally { await h.close() }
  })

test("correction withholds old answer but reconciles completed actions",
  async () => {
    let release!: () => void
    const h = await harness(async context => {
      if (context.task === "Write A once") {
        await new Promise<void>(done => { release = done })
        return finding
      }
      expect(context.backendHistory?.[0]).toMatchObject({
        summary: "A was written.", outcome: "completed",
        delivery: "withheld", reason: "new_delegation",
      })
      expect(context.backendHistory?.[0].requestContext).toContain("Write A")
      return { status: "completed", summary: "A exists; checked B only." }
    })
    try {
      h.request()
      await until(() => !!release)
      h.speech("Actually check B; do not write A again")
      h.request("b", "Reconcile A then check B; do not repeat the write")
      release()
      await h.c.idle()
      expect(h.c.runs).toBe(2)
      expect(h.responses()).toHaveLength(2)
      expect(h.responses()[0].response.result).toContain("Result withheld")
      expect(h.responses()[0].response.result).not.toContain("A was written")
      expect(h.responses()[1].response.result).toContain("checked B only")
      expect(h.responses().every(r => r.scheduling === "WHEN_IDLE"))
        .toBe(true)
    } finally { await h.close() }
  })

test("multiple calls serialize, reject overflow, and expire without leaks",
  async () => {
    let release!: () => void
    let now = 0
    let active = 0
    let maximum = 0
    const h = await harness(async () => {
      maximum = Math.max(maximum, ++active)
      await new Promise<void>(done => { release = done })
      active--
      return finding
    }, { now: () => now, queueMs: 10 })
    try {
      h.request()
      await until(() => !!release)
      h.message({ toolCall: { functionCalls: [
        h.call("b"), h.call("c"), h.call("d"), h.call("e"), h.call("f"),
      ] } })
      now = 20
      release()
      await h.c.idle()
      expect(maximum).toBe(1)
      expect(h.c.runs).toBe(1)
      expect(h.responses()).toHaveLength(6)
      expect(h.responses()[0].response.result).toContain("rejected")
      expect(h.responses().filter(r => r.response.result.includes("expired")))
        .toHaveLength(4)
      expect(h.c.historyContext().tasks.every(t =>
        t.resolution?.delivery === "sent")).toBe(true)
      h.request("f")
      expect(h.c.runs).toBe(1)
    } finally { await h.close() }
  })

test("per-call cancellation before execution and while queued is isolated",
  async () => {
    let release!: () => void
    let signal!: AbortSignal
    const h = await harness(async (_context, s) => {
      signal = s
      await new Promise<void>(done => { release = done })
      return finding
    })
    try {
      h.cancel("before")
      h.request("before")
      h.request("settling")
      h.cancel("settling")
      await h.c.idle()
      expect(h.c.runs).toBe(0)
      h.request("active")
      await until(() => !!release)
      h.request("queued")
      h.cancel("queued", "queued")
      expect(signal.aborted).toBe(false)
      release()
      await h.c.idle()
      expect(h.c.runs).toBe(1)
      expect(h.responses().map(r => r.id)).toEqual(["active"])
      expect(h.c.historyContext().tasks.filter(t => t.providerCancelled))
        .toHaveLength(2)
      expect(h.c.historyContext().tasks.find(t =>
        t.delegationId === "queued")?.resolution).toEqual({
        outcome: "cancelled", delivery: "not_sent",
      })
    } finally { await h.close() }
  })

test("active cancellation retains a late finding but never sends it",
  async () => {
    let signal!: AbortSignal
    const h = await harness(async (context, s) => {
      if (context.task === "Write A once") {
        signal = s
        await new Promise<void>(done => {
          s.addEventListener("abort", () => done(), { once: true })
        })
        return finding // A write may have finished before local cleanup.
      }
      expect(context.backendHistory?.[0]).toMatchObject({
        outcome: "cancelled", providerCancelled: true,
        summary: "A was written.", delivery: "not_sent",
      })
      return { status: "completed", summary: "Verified A; no repeat write." }
    })
    try {
      h.request()
      await until(() => !!signal)
      h.request("b", "Check actual state of A; do not write again")
      h.cancel("a")
      expect(signal.aborted).toBe(true)
      await h.c.idle()
      expect(h.responses().map(r => r.id)).toEqual(["b"])
      h.request("a")
      expect(h.c.runs).toBe(2)
      // Cancellation after delivery preserves facts; no result recall.
      h.cancel("b")
      expect(h.c.historyContext().tasks[1]).toMatchObject({
        outcome: "completed", delivery: "sent", providerCancelled: true,
      })
      expect(h.responses()).toHaveLength(1)
    } finally { await h.close() }
  })

for (const mode of [
  "pressure", "throw", "cancelDuringSend", "closed",
] as const) {
  test(`result delivery ${mode} settles once without retry or false ack`,
    async () => {
      let release!: () => void
      const h = await harness(async () => {
        await new Promise<void>(done => { release = done })
        return finding
      })
      try {
        h.request()
        await until(() => !!release)
        let attempts = 0
        h.socket.send = () => {
          attempts++
          if (mode === "throw") throw new Error("private transport failure")
          if (mode === "cancelDuringSend") h.cancel("a")
        }
        if (mode === "pressure") h.socket.bufferedAmount = 256000
        if (mode === "closed") await h.session.close()
        release()
        await h.c.idle()
        expect(h.c.historyContext().tasks[0].resolution?.delivery).toBe(
          mode === "pressure" || mode === "closed" ? "not_sent" : "uncertain",
        )
        const receipt = await h.session.complete({
          owner: h.session.owner, requestId: "a", outcome: "completed",
          summary: "do not resend",
        })
        expect(receipt.transmission).toBe("not_sent")
        expect(attempts).toBe(mode === "throw" || mode === "cancelDuringSend"
          ? 1 : 0)
        expect(h.c.busy).toBe(false)
      } finally { await h.close() }
    })
}

test("wrong owner and unknown call cannot send; fresh owners can reuse IDs",
  async () => {
    const a = await harness()
    const b = await harness()
    try {
      await expect(a.session.complete({ owner: b.session.owner,
        requestId: "a", outcome: "cancelled" })).rejects.toThrow("owner")
      expect(await a.session.complete({ owner: a.session.owner,
        requestId: "unknown", outcome: "cancelled" })).toMatchObject({
        transmission: "not_sent",
      })
      a.request()
      b.request()
      await Promise.all([a.c.idle(), b.c.idle()])
      expect(a.c.runs).toBe(1)
      expect(b.c.runs).toBe(1)
    } finally { await a.close(); await b.close() }
  })

for (const bad of [
  { name: "other", id: "b", args: { task: "run" } },
  { name: "delegate", id: "", args: { task: "run" } },
  { name: "delegate", id: "b", args: { task: " " } },
  { name: "delegate", id: "b", args: { task: "😀".repeat(1025) } },
  { name: "delegate", id: "b", args: { task: "run", extra: true } },
  { name: "delegate", id: "b", args: "run" },
]) {
  test("malformed call fails the whole event before any work begins",
    async () => {
      const h = await harness()
      try {
        h.message({ toolCall: { functionCalls: [h.call(), bad] } })
        await h.c.idle()
        expect(h.losses()).toBe(1)
        expect(h.c.runs).toBe(0)
        expect(h.responses()).toEqual([])
      } finally { await h.close() }
    })
}

test("retained cancellation IDs have a hard bound, never eviction/replay",
  async () => {
    const h = await harness()
    try {
      for (let i = 0; i < 256; i++) h.cancel(`call-${i}`)
      h.cancel("call-0")
      expect(h.losses()).toBe(0)
      h.request("call-0")
      expect(h.c.runs).toBe(0)
      h.cancel("over-limit")
      expect(h.losses()).toBe(1)
    } finally { await h.close() }
  })

test("backend timeout settles with uncertain-action summary, without retry",
  async () => {
    const h = await harness(async () => {
      await runChild({ command: [process.execPath],
        args: ["-e", "setInterval(() => {}, 1000)"], input: "",
        cwd: process.cwd(), timeoutMs: 10, graceMs: 5 })
      return finding
    })
    try {
      h.request()
      await h.c.idle()
      expect(h.responses()).toHaveLength(1)
      expect(h.responses()[0].response.result).toContain("failed:")
      expect(h.responses()[0].response.result)
        .toContain("Actions may already have happened")
      h.request()
      expect(h.c.runs).toBe(1)
    } finally { await h.close() }
  })

test("several calls in one event run serially and settle every valid ID",
  async () => {
    let active = 0
    let maximum = 0
    const h = await harness(async () => {
      maximum = Math.max(maximum, ++active)
      await Bun.sleep(5)
      active--
      return finding
    })
    try {
      h.message({ toolCall: { functionCalls: [
        h.call("a"), h.call("b"), h.call("a"), h.call("c"),
      ] } })
      await h.c.idle()
      expect(maximum).toBe(1)
      expect(h.c.runs).toBe(3)
      expect(h.responses().map(r => r.id)).toEqual(["a", "b", "c"])
      expect(h.responses()[0].response.result).toContain("Result withheld")
      expect(h.responses()[1].response.result).toContain("Result withheld")
      expect(h.responses()[2].response.result).toContain("A was written")
    } finally { await h.close() }
  })

test("local cancellation settles valid calls but does not claim rollback",
  async () => {
    let running = false
    const h = await harness(async (_context, signal) => {
      running = true
      await new Promise<void>(done => {
        signal.addEventListener("abort", () => done(), { once: true })
      })
      return finding
    })
    try {
      h.request()
      await until(() => running)
      h.request("queued")
      h.c.cancel()
      await h.c.idle()
      expect(h.responses()).toHaveLength(2)
      expect(h.responses().every(r => r.response.result.includes(
        "Actions may already have happened",
      ))).toBe(true)
      expect(h.c.historyContext().tasks.every(t =>
        t.resolution?.outcome === "cancelled"
        && t.resolution.delivery === "sent")).toBe(true)
      expect(h.c.runs).toBe(1)
    } finally { await h.close() }
  })

for (const failure of ["exception", "oversize"]) {
  test(`Gemini reports backend ${failure} and remains usable`, async () => {
    let fail = true
    const h = await harness(async () => {
      if (fail && failure === "exception") {
        throw new Error("private backend details")
      }
      return { status: "completed", summary: fail ? "x".repeat(16385)
        : "雪🙂".repeat(2000) }
    })
    try {
      h.request("failure")
      await h.c.idle()
      expect(h.responses()).toHaveLength(1)
      expect(h.responses()[0].response.result)
        .toContain("failed: The backend encountered an error")
      expect(h.responses()[0].response.result)
        .not.toContain("private backend details")
      expect(h.losses()).toBe(0)
      fail = false
      h.request("recovery")
      await h.c.idle()
      expect(h.responses()[1].response.result)
        .toBe("completed: " + "雪🙂".repeat(2000))
      expect(h.losses()).toBe(0)
      expect(h.c.runs).toBe(2)
    } finally { await h.close() }
  })
}
