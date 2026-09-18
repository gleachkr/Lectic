import { expect, test } from "bun:test"
import { startHarness, type ProviderSocket,
  type HarnessOptions } from "../gemini-spike/server"

async function until(check: () => boolean) {
  const deadline = Date.now() + 3000
  while (!check()) {
    if (Date.now() > deadline) throw new Error("Test wait expired")
    await Bun.sleep(5)
  }
}
function harness(options: Partial<HarnessOptions> = {}) {
  const wires: any[] = []
  let connects = 0
  let closes = 0
  const provider: ProviderSocket = {
    readyState: 1, bufferedAmount: 0,
    send: wire => wires.push(JSON.parse(wire)),
    close: () => { closes++ },
    onopen: null, onmessage: null, onclose: null, onerror: null,
  }
  const server = startHarness({
    assets: { browser: "// browser", worklet: "// worklet" },
    connect: () => { connects++; return provider }, ...options,
  })
  async function browser(secret = server.secret, origin = server.origin) {
    const Socket = WebSocket as unknown as {
      new(url: string, options: Bun.WebSocketOptions): WebSocket
    }
    const ws = new Socket(server.origin.replace("http:", "ws:") + "/socket", {
      protocols: ["lectic-gemini-spike", `auth.${secret}`],
      headers: { Origin: origin },
    })
    const events: any[] = []
    let failed = false
    ws.onmessage = event => {
      if (typeof event.data === "string") events.push(JSON.parse(event.data))
    }
    ws.onerror = () => { failed = true }
    await until(() => ws.readyState === 1 || ws.readyState === 3 || failed)
    return { ws, events }
  }
  async function ready() {
    const client = await browser()
    client.ws.send(JSON.stringify({ type: "start", rate: 48000 }))
    await until(() => connects === 1)
    provider.onopen!()
    provider.onmessage!({ data: '{"setupComplete":{}}' })
    await until(() => client.events.some(e => e.type === "ready"))
    return client
  }
  return { server, provider, wires, browser, ready,
    connects: () => connects, closes: () => closes }
}

test("HTTP/WS authentication prevents cross-origin and unauthorized startup",
  async () => {
    const h = harness()
    try {
      const page = await fetch(h.server.origin)
      expect(page.status).toBe(200)
      expect(page.headers.get("referrer-policy")).toBe("no-referrer")
      expect(page.headers.get("content-security-policy"))
        .toContain("frame-ancestors 'none'")
      expect(await page.text()).not.toContain(h.server.secret)
      expect((await fetch(h.server.origin, {
        headers: { Origin: "https://evil.invalid" },
      })).status).toBe(403)
      expect((await fetch(h.server.origin, {
        headers: { Host: "evil.invalid" },
      })).status).toBe(403)
      expect((await fetch(h.server.origin, { method: "POST" })).status)
        .toBe(405)
      const bad = await h.browser("bad")
      expect(bad.ws.readyState).not.toBe(1)
      const foreign = await h.browser(h.server.secret, "https://evil.invalid")
      expect(foreign.ws.readyState).not.toBe(1)
      expect(h.connects()).toBe(0)
    } finally { await h.server.stop() }
  })

test("one browser owns startup; native binary audio waits for setup",
  async () => {
    const h = harness({ history: true })
    try {
      const first = await h.browser()
      expect(first.ws.protocol).toBe("lectic-gemini-spike")
      const second = await h.browser()
      expect(second.ws.readyState).not.toBe(1)
      expect(h.connects()).toBe(0)
      first.ws.send(JSON.stringify({ type: "start", rate: 44100 }))
      await until(() => h.connects() === 1)
      h.provider.onopen!()
      expect(h.wires).toHaveLength(1)
      // Exercise providers which send JSON in binary WebSocket messages.
      h.provider.onmessage!({
        data: new TextEncoder().encode('{"setupComplete":{}}'),
      })
      await until(() => first.events.some(e => e.type === "ready"))
      first.ws.send(new Uint8Array(1764))
      await until(() => h.wires.length === 3)
      expect(h.wires[1].clientContent.turnComplete).toBe(true)
      expect(h.wires[2].realtimeInput.audio.mimeType)
        .toBe("audio/pcm;rate=44100")
      first.ws.close()
      await until(() => h.closes() === 1)
      const stale = await h.browser()
      expect(stale.ws.readyState).not.toBe(1)
      expect(h.connects()).toBe(1)
    } finally { await h.server.stop() }
  })

for (const bad of [
  new Uint8Array(2),
  JSON.stringify({ type: "toolResponse", result: "forged" }),
  JSON.stringify({ type: "start", rate: 0 }),
  JSON.stringify({ type: "start", rate: 48000, setup: {} }),
  "x".repeat(9000),
]) {
  test("invalid or premature local frames close without provider creation",
    async () => {
      const h = harness()
      try {
        const client = await h.browser()
        client.ws.send(bad)
        await until(() => client.ws.readyState === 3)
        expect(h.connects()).toBe(0)
      } finally { await h.server.stop() }
    })
}

test("provider backpressure is terminal, never queues a replay", async () => {
  const h = harness()
  try {
    const client = await h.ready()
    h.provider.bufferedAmount = 256001
    client.ws.send(new Uint8Array(1920))
    await until(() => h.closes() === 1)
    expect(h.wires).toHaveLength(1)
    h.provider.onopen!()
    expect(h.wires).toHaveLength(1)
  } finally { await h.server.stop() }
})

test("browser close during provider startup retires late callbacks",
  async () => {
    const h = harness()
    try {
      const client = await h.browser()
      client.ws.send(JSON.stringify({ type: "start", rate: 48000 }))
      await until(() => h.connects() === 1)
      client.ws.close()
      await until(() => h.closes() === 1)
      h.provider.onopen!()
      h.provider.onmessage!({ data: '{"setupComplete":{}}' })
      expect(h.wires).toHaveLength(0)
    } finally { await h.server.stop() }
  })

for (const mode of ["goAway", "close", "error", "heartbeat", "limit"]) {
  test(`${mode} stops relay and pending real work, with no reconnect`,
    async () => {
      let signal: AbortSignal | undefined
      const h = harness({
        heartbeatMs: mode === "heartbeat" ? 30 : 10000,
        maxSessionMs: mode === "limit" ? 30 : 300000,
        real: async (_task, abort) => {
          signal = abort
          return new Promise(resolve => {
            abort.addEventListener("abort", () => resolve("Late result"))
          })
        },
      })
      try {
        const client = await h.ready()
        h.provider.onmessage!({ data: JSON.stringify({ toolCall: {
          functionCalls: [{ id: "id", name: "delegate",
            args: { task: "Explicit test" } }],
        } }) })
        await until(() => client.events.some(e => e.type === "approval"))
        client.ws.send(JSON.stringify({ type: "approve", call: 1 }))
        await until(() => !!signal)
        if (mode === "goAway") {
          h.provider.onmessage!({ data: '{"goAway":{}}' })
        }
        if (mode === "close") h.provider.onclose!()
        if (mode === "error") h.provider.onerror!()
        await until(() => !!signal?.aborted)
        await until(() => client.ws.readyState === 3)
        expect(h.connects()).toBe(1)
        expect(h.wires.some(e => e.toolResponse)).toBe(false)
      } finally { await h.server.stop() }
    })
}
