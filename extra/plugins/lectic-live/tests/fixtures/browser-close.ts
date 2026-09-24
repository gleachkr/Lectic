// Opt-in real Chromium regression. No provider calls or microphone capture.
// Run: bun extra/plugins/lectic-live/tests/fixtures/browser-close.ts
import { spawn } from "node:child_process"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { startServer } from "../../server"

async function until(check: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 2000
  while (!await check()) {
    if (Date.now() > deadline) throw new Error("Browser close wait expired")
    await Bun.sleep(10)
  }
}

async function check(provider: "openai" | "gemini", wholeBrowser: boolean) {
  const executable = process.env["CHROME"] ?? Bun.which("chromium")
  if (!executable) throw new Error("Install Chromium or set CHROME")
  const dir = await mkdtemp(join(tmpdir(), "live-browser-close-"))
  const server = startServer({ provider,
    connect: async () => { throw new Error("No provider calls allowed") },
    backend: async () => { throw new Error("No backend work allowed") },
  })
  let stopped = false
  void server.stopped.then(() => { stopped = true })
  const chrome = spawn(executable, [
    "--headless=new", "--no-sandbox", "--no-first-run",
    "--disable-background-networking", "--remote-debugging-port=0",
    `--user-data-dir=${dir}`, "about:blank",
  ], { stdio: ["ignore", "ignore", "pipe"] })
  const exited = new Promise<void>(resolve => {
    chrome.once("exit", () => resolve())
    chrome.once("error", () => resolve())
  })
  let socket: WebSocket | undefined
  const pending = new Map<number, {
    resolve(value: any): void; reject(error: Error): void;
    timer: ReturnType<typeof setTimeout>
  }>()
  try {
    const endpoint = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Chromium timeout")),
        10000)
      let buffer = ""
      chrome.stderr.on("data", chunk => {
        buffer = (buffer + String(chunk)).slice(-4096)
        const url = buffer.match(/ws:\/\/127\.0\.0\.1:\d+\/\S+/)?.[0]
        if (url) { clearTimeout(timer); resolve(url) }
      })
      chrome.once("error", error => { clearTimeout(timer); reject(error) })
      chrome.once("exit", () => {
        clearTimeout(timer)
        reject(new Error("Chromium exited before DevTools was ready"))
      })
    })
    socket = new WebSocket(endpoint)
    await until(() => socket!.readyState === 1)
    socket.onmessage = event => {
      const message = JSON.parse(String(event.data))
      const request = pending.get(message.id)
      if (!request) return
      clearTimeout(request.timer)
      pending.delete(message.id)
      if (message.error) request.reject(new Error(message.error.message))
      else request.resolve(message.result)
    }
    let id = 0
    function cdp(method: string, params = {}, sessionId?: string) {
      return new Promise<any>((resolve, reject) => {
        const current = ++id
        const timer = setTimeout(() => {
          pending.delete(current)
          reject(new Error(`DevTools timeout: ${method}`))
        }, 5000)
        pending.set(current, { resolve, reject, timer })
        socket!.send(JSON.stringify({ id: current, method, params,
          sessionId }))
      })
    }
    const { targetId } = await cdp("Target.createTarget", {
      url: "about:blank",
    })
    const { sessionId } = await cdp("Target.attachToTarget", {
      targetId, flatten: true,
    })
    await cdp("Page.enable", {}, sessionId)
    await cdp("Page.addScriptToEvaluateOnNewDocument", { source: `
      if (navigator.mediaDevices) {
        navigator.mediaDevices.getUserMedia = () => {
          window.permissionRequested = true;
          return new Promise(() => {});
        };
      }
    ` }, sessionId)
    await cdp("Page.navigate", { url: server.url }, sessionId)
    await until(async () => {
      const value = await cdp("Runtime.evaluate", {
        expression: "window.permissionRequested === true",
        returnByValue: true,
      }, sessionId)
      return value.result.value === true
    })
    const began = Date.now()
    await cdp(wholeBrowser ? "Browser.close" : "Target.closeTarget",
      wholeBrowser ? {} : { targetId })
    // Fail well before the ten-second watchdog: it must be socket cleanup.
    await until(() => stopped)
    console.log(`${provider} ${wholeBrowser ? "browser" : "tab"} close: `
      + `${Date.now() - began} ms`)
  } finally {
    for (const request of pending.values()) clearTimeout(request.timer)
    socket?.close()
    chrome.kill("SIGTERM")
    const kill = setTimeout(() => chrome.kill("SIGKILL"), 2000)
    await exited
    clearTimeout(kill)
    await server.stop()
    await rm(dir, { recursive: true, force: true })
  }
}

if (import.meta.main) {
  for (const provider of ["openai", "gemini"] as const) {
    for (const wholeBrowser of [false, true]) {
      await check(provider, wholeBrowser)
    }
  }
}
