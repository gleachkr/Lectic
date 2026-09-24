import { expect, test } from "bun:test"
import type { ServerWebSocket } from "bun"
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { historyRoot, loadHistory } from "../history"
import { fakeCommand, realCommand, workspace } from "./helpers"

async function until(
  check: () => boolean | Promise<boolean>, timeout = 5000,
) {
  const deadline = Date.now() + timeout
  while (!await check()) {
    if (Date.now() > deadline) throw new Error("Test wait expired")
    await Bun.sleep(10)
  }
}

const installed = Bun.which("lectic")
const runtimes = [realCommand, ...(installed ? [[installed]] : [])]
for (const [runtime, command] of runtimes.entries()) {
for (const mode of ["close", "socket-first", "heartbeat", "lifetime"]) {
  test(`kept active CLI exits on ${mode}, runtime ${runtime}`, async () => {
    const ws = await workspace()
    let child: Bun.Subprocess<"ignore", "pipe", "pipe"> | undefined
    let browser: WebSocket | undefined
    let lifetime: WebSocket | undefined
    let provider: ServerWebSocket<undefined> | undefined
    let closed = false
    let responses = 0
    const fake = Bun.serve<undefined>({
      hostname: "127.0.0.1", port: 0,
      fetch(request, server) {
        if (server.upgrade(request)) return
        return new Response("WebSocket only", { status: 400 })
      },
      websocket: {
        open(socket) { provider = socket },
        message(socket, raw) {
          const value = JSON.parse(String(raw))
          if (value.setup) socket.send('{"setupComplete":{}}')
          if (value.toolResponse) responses++
        },
        close() { closed = true },
      },
    })
    try {
      const bin = join(ws.dir, "bin")
      await mkdir(bin)
      // Only backend generation is substituted; runLectic still owns cleanup.
      await writeFile(join(bin, "lectic"), '#!/bin/sh\nexec '
        + fakeCommand.map(s => JSON.stringify(s)).join(" ")
        + ' "$@"\n', { mode: 0o755 })
      const capture = join(ws.dir, "backend-started.json")
      child = Bun.spawn([...command, "script",
        join(import.meta.dir, "fixtures/live-cli.ts"), "--controller",
        "-f", ws.seed, "--model", "gemini-3.8-live", "--keep-history",
      ], {
        cwd: ws.cwd, env: { ...ws.env, PATH: `${bin}:${ws.env.PATH}`,
          GEMINI_API_KEY: "unused-loopback-only", LIVE_TEST_MODE: "slow",
          LIVE_TEST_CAPTURE: capture,
          TEST_PROVIDER_URL: `ws://127.0.0.1:${fake.port}`,
        }, stdin: "ignore", stdout: "pipe", stderr: "pipe",
      })
      const stderr = new Response(child.stderr).text()
      const reader = child.stdout.getReader()
      const line = new TextDecoder().decode((await reader.read()).value)
      expect(line).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/#\w{64}\n$/)
      const url = new URL(line.trim())
      const post = (path: string, body = {}) => fetch(url.origin + path, {
        method: "POST", headers: { Origin: url.origin,
          Authorization: `Bearer ${url.hash.slice(1)}`,
          "Content-Type": "application/json" }, body: JSON.stringify(body),
      })
      const Socket = WebSocket as unknown as {
        new(url: string, options: Bun.WebSocketOptions): WebSocket
      }
      if (mode === "lifetime") {
        lifetime = new Socket(
          url.origin.replace("http:", "ws:") + "/lifetime", {
            protocols: ["lectic-live-lifetime", `auth.${url.hash.slice(1)}`],
            headers: { Origin: url.origin },
          },
        )
        await until(() => lifetime!.readyState === 1)
      }
      browser = new Socket(url.origin.replace("http:", "ws:") + "/socket", {
        protocols: ["lectic-live-pcm", `auth.${url.hash.slice(1)}`],
        headers: { Origin: url.origin },
      })
      await until(() => browser!.readyState === 1)
      expect((await post("/start", { rate: 48000 })).status).toBe(200)
      expect((await post("/ready", { events: [] })).status).toBe(200)
      provider!.send(JSON.stringify({ serverContent: {
        inputTranscription: { text: "Do this once, then close" },
      } }))
      provider!.send(JSON.stringify({ toolCall: {
        functionCalls: [{ id: "work", name: "delegate",
        args: { task: "Slow offline task" } }] } }))
      await until(() => Bun.file(capture).exists())
      expect(child.exitCode).toBeNull()
      if (mode !== "close") browser.close(1000)
      if (mode === "lifetime") lifetime!.close()
      else if (mode !== "heartbeat") {
        expect((await post("/close")).status).toBe(200)
      }
      await until(() => child!.exitCode !== null,
        mode === "lifetime" ? 3000 : 15000)
      expect(await child.exited).toBe(0)
      expect((await reader.read()).done).toBe(true)
      expect(await stderr).not.toContain("unused-loopback-only")
      expect(closed).toBe(true)
      expect(responses).toBe(0)
      const ids = await readdir(historyRoot(ws.env))
      expect(ids).toHaveLength(1)
      const context = loadHistory(ids[0], historyRoot(ws.env))
      expect(context.fragments[0].text).toBe("Do this once, then close")
      expect(context.tasks[0]).toMatchObject({ outcome: "cancelled",
        delivery: "not_sent" })
      const dir = join(historyRoot(ws.env), ids[0], "runs")
      const runs = await readdir(dir)
      expect(runs).toHaveLength(1)
      expect(await readFile(join(dir, runs[0], "error.txt"), "utf8"))
        .toContain("cancelled")
      await expect(fetch(url)).rejects.toThrow()
    } finally {
      lifetime?.close()
      browser?.close()
      if (child) {
        child.kill("SIGTERM")
        await Promise.race([child.exited, Bun.sleep(1000)])
        child.kill("SIGKILL")
        await child.exited
      }
      provider?.terminate()
      await Promise.race([fake.stop(true), Bun.sleep(100)])
      await ws.cleanup()
    }
  }, 25_000)
}
}
