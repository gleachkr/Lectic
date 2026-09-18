import { expect, test } from "bun:test"
import { SpikeSession, type SpikeOptions } from "../gemini-spike/session"

const call = (id = "private-id", task = "private task") => ({
  toolCall: { functionCalls: [{ id, name: "delegate", args: { task } }] },
})
const cancel = (id = "private-id") => ({
  toolCallCancellation: { ids: [id] },
})
function fixture(options: Partial<SpikeOptions> = {}) {
  const sent: any[] = []
  const browser: any[] = []
  let closed = 0
  const session = new SpikeSession({
    fakeDelayMs: 20,
    sendProvider: wire => sent.push(JSON.parse(wire)),
    sendBrowser: data => browser.push(typeof data === "string"
      ? JSON.parse(data) : data),
    close: () => closed++, ...options,
  })
  const receive = (event: unknown) => session.receive(JSON.stringify(event))
  const ready = () => {
    session.open(48000)
    receive({ setupComplete: {} })
  }
  return { session, receive, ready, sent, browser, closed: () => closed }
}

test("setup gates audio/results and history precedes readiness", () => {
  const f = fixture({ history: true })
  try {
    f.session.open(44100)
    expect(() => f.session.capture(new Uint8Array(1764))).toThrow()
    expect(f.sent).toHaveLength(1)
    f.receive({ setupComplete: {} })
    expect(f.sent[1].clientContent.turnComplete).toBe(true)
    f.session.capture(new Uint8Array(1764))
    expect(f.sent[2].realtimeInput.audio.mimeType)
      .toBe("audio/pcm;rate=44100")
    expect(() => f.session.capture(new Uint8Array(1920))).toThrow()
    expect(f.browser.find(e => e.type === "ready").rate).toBe(44100)
  } finally { f.session.stop("test_end") }
  const early = fixture()
  early.session.open(48000)
  early.receive(call())
  expect(early.session.ended).toBe(true)
  expect(early.sent).toHaveLength(1)
})

test("slow tasks allow speech, deduplicate and send WHEN_IDLE once",
  async () => {
    const f = fixture()
    f.ready()
    f.receive(call())
    f.receive(call())
    for (let i = 0; i < 2; i++) {
      f.receive({ serverContent: {
        inputTranscription: { text: " no no" }, turnComplete: true,
      } })
    }
    f.session.capture(new Uint8Array(1920))
    expect(f.sent.some(e => e.toolResponse)).toBe(false)
    expect(f.browser.filter(e => e.type === "transcript")
      .map(e => e.text)).toEqual([" no no", " no no"])
    await f.session.idle()
    expect(f.sent.filter(e => e.toolResponse)).toHaveLength(1)
    const result = f.sent.at(-1).toolResponse.functionResponses[0]
    expect(result.scheduling).toBe("WHEN_IDLE")
    expect(result.willContinue).toBe(false)
    expect(f.browser.some(e => e.code === "result_sent_unacknowledged"))
      .toBe(true)
    f.receive(cancel())
    expect(f.browser.find(e => e.code === "provider_cancel").alreadySent)
      .toBe(true)
    expect(JSON.stringify(f.browser.filter(e => e.type === "trace")))
      .not.toContain("private")
    f.session.stop("test_end")
  })

test("cancellation suppresses queued, active, and late fake results",
  async () => {
    const f = fixture()
    f.ready()
    f.receive(call())
    f.receive(call("queued"))
    f.receive(cancel("queued"))
    f.receive(cancel())
    f.receive(call())
    await f.session.idle()
    expect(f.sent.some(e => e.toolResponse)).toBe(false)
    f.receive(call("correction"))
    await f.session.idle()
    expect(f.sent.at(-1).toolResponse.functionResponses[0].id)
      .toBe("correction")
    f.session.stop("test_end")
  })

test("real request needs specific authorization and runs at most once",
  async () => {
    const ran: string[] = []
    const f = fixture({ real: async task => {
      ran.push(task)
      return "Done"
    } })
    f.ready()
    f.receive(call())
    expect(ran).toEqual([])
    expect(() => f.session.approve(2)).toThrow()
    f.session.approve(1)
    await f.session.idle()
    expect(ran).toEqual(["private task"])
    f.receive(call("second"))
    await f.session.idle()
    expect(ran).toHaveLength(1)
    expect(f.sent.at(-1).toolResponse.functionResponses[0].response.result)
      .toContain("No work performed")
    expect(() => f.session.approve(2)).toThrow()
    f.session.stop("test_end")
  })

test("cancelled approvals cannot start real work; close aborts active work",
  async () => {
    let signal: AbortSignal | undefined
    let finish: (value: string) => void = () => {}
    const f = fixture({ real: async (_task, abort) => {
      signal = abort
      return new Promise<string>(resolve => { finish = resolve })
    } })
    f.ready()
    f.receive(call())
    f.receive(cancel())
    expect(() => f.session.approve(1)).toThrow()
    expect(signal).toBeUndefined()
    f.receive(call("second"))
    f.session.approve(2)
    f.receive({ goAway: { timeLeft: "30s" } })
    expect(signal!.aborted).toBe(true)
    expect(f.closed()).toBe(1)
    finish("Late result")
    await f.session.idle()
    f.receive(call("after-close"))
    expect(f.sent.some(e => e.toolResponse)).toBe(false)
    f.session.stop("again")
    expect(f.closed()).toBe(1)
  })

test("interruption flushes immediately; send loss is terminal without retry",
  async () => {
    const f = fixture({ sendProvider: wire => {
      if (JSON.parse(wire).toolResponse) throw new Error("private failure")
    } })
    f.ready()
    f.receive(call())
    f.receive({ serverContent: { interrupted: true } })
    expect(f.browser.some(e => e.type === "flush")).toBe(true)
    await f.session.idle()
    expect(f.session.ended).toBe(true)
    expect(f.browser.some(e => e.code === "result_delivery_uncertain"))
      .toBe(true)
    expect(JSON.stringify(f.browser)).not.toContain("private failure")
  })

test("queue overflow ends session; unknown cancelled IDs stay suppressed",
  async () => {
    const f = fixture()
    f.ready()
    f.receive(cancel("unknown"))
    f.receive(call("unknown"))
    expect(f.browser.some(e => e.code === "task_started")).toBe(false)
    for (let i = 0; i < 5; i++) f.receive(call(String(i)))
    expect(f.session.ended).toBe(true)
    await f.session.idle()
    expect(f.sent.some(e => e.toolResponse)).toBe(false)
  })

test("usage with GoAway is retained without pretending it is final", () => {
  const f = fixture()
  f.ready()
  f.receive({ goAway: {}, usageMetadata: { totalTokenCount: 9 } })
  const usage = f.browser.find(e => e.code === "usage_latest_not_final")
  expect(usage.counters).toEqual({ totalTokenCount: 9 })
  expect(f.session.ended).toBe(true)
})

test("duplicate setup is terminal and sends no history twice", () => {
  const f = fixture({ history: true })
  f.ready()
  f.receive({ setupComplete: {} })
  expect(f.session.ended).toBe(true)
  expect(f.sent.filter(e => e.clientContent)).toHaveLength(1)
})
