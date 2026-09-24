import { expect, test } from "bun:test"
import { startServer } from "../server"
import type { ProviderConnect } from "../provider"

async function until(check: () => boolean) {
  const deadline = Date.now() + 2000
  while (!check()) {
    if (Date.now() > deadline) throw new Error("Test wait expired")
    await Bun.sleep(5)
  }
}

function fixture(provider: "openai" | "gemini", connect?: ProviderConnect) {
  let closes = 0
  let stopped = false
  const s = startServer({ provider, heartbeatMs: 60000,
    backend: async () => { throw new Error("No backend work expected") },
    connect: connect ?? (async () => ({
      owner: { provider, sessionId: "offline", sessionIdSource: "local" },
      media: provider === "openai" ? { kind: "webrtc", sdp: "fake" }
        : { kind: "pcm", capture() {}, attach() {} },
      bootstrap: () => [],
      complete: async () => ({ transmission: "not_sent",
        acknowledgment: "unavailable" }),
      close: async () => {
        closes++
        return { transport: "closed", remote: "ended", usage: "final" }
      },
    })),
  })
  void s.stopped.then(() => { stopped = true })
  const sockets: WebSocket[] = []
  async function socket(path = "/lifetime", secret = s.secret,
    origin = s.origin, protocol = "lectic-live-lifetime", host?: string) {
    const Socket = WebSocket as unknown as {
      new(url: string, options: Bun.WebSocketOptions): WebSocket
    }
    const ws = new Socket(s.origin.replace("http:", "ws:") + path, {
      protocols: [protocol, `auth.${secret}`],
      headers: { Origin: origin, ...(host ? { Host: host } : {}) },
    })
    sockets.push(ws)
    let error = false
    ws.onerror = () => { error = true }
    await until(() => error || ws.readyState === 1 || ws.readyState === 3)
    return ws
  }
  const post = (path: string, body = {}) => fetch(s.origin + path, {
    method: "POST", headers: { Origin: s.origin,
      Authorization: `Bearer ${s.secret}`, "Content-Type": "application/json",
    }, body: JSON.stringify(body),
  })
  return { s, socket, post, closes: () => closes, stopped: () => stopped,
    async ready() {
      if (provider === "gemini") {
        await socket("/socket", s.secret, s.origin, "lectic-live-pcm")
      }
      expect((await post("/start", provider === "gemini"
        ? { rate: 48000 } : { sdp: "offer" })).status).toBe(200)
      expect((await post("/ready", { events: [] })).status).toBe(200)
    },
    async cleanup() {
      await s.stop()
      sockets.forEach(ws => ws.close())
    },
  }
}

for (const provider of ["openai", "gemini"] as const) {
  test(`${provider} lifetime is authenticated and single-owner`, async () => {
    const f = fixture(provider)
    try {
      for (const [secret, origin, protocol, host] of [
        ["wrong", f.s.origin, "lectic-live-lifetime"],
        [f.s.secret, "https://foreign.invalid", "lectic-live-lifetime"],
        [f.s.secret, "", "lectic-live-lifetime"],
        [f.s.secret, f.s.origin, "lectic-live-pcm"],
        [f.s.secret, f.s.origin, "lectic-live-lifetime", "wrong.invalid"],
      ]) {
        const rejected = await f.socket("/lifetime", secret, origin,
          protocol, host)
        expect(rejected.readyState).not.toBe(1)
        expect(f.stopped()).toBe(false)
      }
      const owner = await f.socket()
      expect(owner.protocol).toBe("lectic-live-lifetime")
      expect(owner.protocol).not.toContain(f.s.secret)
      expect((await f.socket()).readyState).not.toBe(1)
      expect(f.stopped()).toBe(false)
      owner.close()
      await until(f.stopped)
      expect(f.closes()).toBe(0)
    } finally { await f.cleanup() }
  })

  for (const phase of ["active", "idle"] as const) {
    test(`${provider} ${phase} lifetime close stops without pagehide`,
      async () => {
        const f = fixture(provider)
        try {
          const owner = await f.socket()
          await f.ready()
          if (phase === "idle") {
            expect(await (await f.post("/idle", {
              sessionId: "offline",
            })).json()).toEqual({ idle: true })
          }
          expect(owner.readyState).toBe(1)
          owner.close()
          await until(f.stopped)
          expect(f.closes()).toBe(1)
          await expect(fetch(f.s.origin)).rejects.toThrow()
        } finally { await f.cleanup() }
      })
  }

  test(`${provider} lifetime loss aborts provider startup`, async () => {
    let aborted = false
    let starting = false
    const f = fixture(provider, async (_offer, _receive, _lost, signal) => {
      starting = true
      await new Promise<void>(resolve => {
        signal.addEventListener("abort", () => {
          aborted = true
          resolve()
        }, { once: true })
      })
      throw new Error("Offline startup aborted")
    })
    try {
      const owner = await f.socket()
      if (provider === "gemini") {
        await f.socket("/socket", f.s.secret, f.s.origin, "lectic-live-pcm")
      }
      const response = f.post("/start", provider === "gemini"
        ? { rate: 48000 } : { sdp: "offer" }).catch(() => undefined)
      await until(() => starting)
      owner.close()
      await until(f.stopped)
      expect(aborted).toBe(true)
      await response
    } finally { await f.cleanup() }
  })
}

test("lifetime socket rejects messages rather than accepting commands",
  async () => {
    const f = fixture("openai")
    try {
      const owner = await f.socket()
      owner.send('{"type":"start"}')
      await until(f.stopped)
      expect(f.closes()).toBe(0)
    } finally { await f.cleanup() }
  })
