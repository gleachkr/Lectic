import { expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { writeFile } from "node:fs/promises"
import { join } from "node:path"
import { runChild } from "../lectic-runner"
import { replaySpike } from "../spike"
import { workspace, fakeCommand } from "./helpers"
import events from "./fixtures/events.json"

const child = (script: string) => ({
  command: [process.execPath], args: ["-e", script],
  input: "", cwd: process.cwd(), graceMs: 30,
})

test("stdin closes; nonzero exits and output floods are bounded",
  async () => {
    expect(await runChild(child('console.log(await Bun.stdin.text())')))
      .toBe("\n")
    await expect(runChild(child('process.exit(7)'))).rejects.toThrow("failed")
    await expect(runChild({
      ...child('process.stdout.write("x".repeat(10000))'), maxBytes: 100,
    })).rejects.toThrow("size limit")
    await expect(runChild({
      ...child('process.stderr.write("x".repeat(10000))'), maxBytes: 100,
    })).rejects.toThrow("size limit")
    await expect(runChild({
      ...child(''), command: ["/nonexistent/lectic"],
    })).rejects.toThrow("start")
  })

test("timeout kills a TERM-resistant process group, including grandchildren",
  async () => {
    const ws = await workspace()
    try {
      const marker = join(ws.dir, "descendant-survived")
      const script = `
        process.on("SIGTERM", () => {});
        Bun.spawn([process.execPath, "-e", ${JSON.stringify(`
          process.on("SIGTERM", () => {});
          setTimeout(() => {
            require("fs").writeFileSync(${JSON.stringify(marker)}, "bad");
          }, 700);
          setInterval(() => {}, 1000);
        `)}], {stdout: "inherit", stderr: "inherit"});
        setInterval(() => {}, 1000);
      `
      await expect(runChild({ ...child(script), timeoutMs: 250 }))
        .rejects.toThrow("timed out")
      await Bun.sleep(800)
      expect(existsSync(marker)).toBe(false)
    } finally { await ws.cleanup() }
  }, 5000)

test("a successful leader cannot leave a pipe-holding tool process behind",
  async () => {
    const script = `
      Bun.spawn([process.execPath, "-e", ${JSON.stringify(`
        process.on("SIGTERM", () => {});
        setInterval(() => {}, 1000);
      `)}], {stdout: "inherit", stderr: "inherit"});
      console.log("done");
      process.exit(0);
    `
    expect(await runChild({ ...child(script), timeoutMs: 2000 }))
      .toBe("done\n")
  }, 5000)

test("cancellation waits for real CLI cleanup, never releases an early pass",
  async () => {
    const ws = await workspace()
    const abort = new AbortController()
    try {
      const capture = join(ws.dir, "started")
      const hook = "#!/bin/sh\nprintf '%s' \"$RUN_STATUS\" > hook-ended"
      const source = ws.source.replace("imports:", [
        "hooks:", "  - on: run_end", `    do: ${JSON.stringify(hook)}`,
        "imports:",
      ].join("\n"))
      await writeFile(ws.seed, source)
      const pending = replaySpike(events.map(e => JSON.stringify(e)), "s", {
        ...ws, command: fakeCommand, signal: abort.signal,
        env: { ...ws.env, SPIKE_MODE: "slow", SPIKE_CAPTURE: capture },
      })
      // Attach rejection handling before cancellation.
      const checked = pending.then(
        () => { throw new Error("Unexpected success") },
        (error: Error) => error,
      )
      const deadline = Date.now() + 10_000
      while (!existsSync(capture) && Date.now() < deadline) {
        await Bun.sleep(20)
      }
      expect(existsSync(capture)).toBe(true)
      abort.abort()
      expect((await checked).message).toContain("cancelled")
      expect(readFileSync(ws.seed, "utf8")).toBe(source)
      expect(readFileSync(join(ws.cwd, "hook-ended"), "utf8")).toBe("error")
    } finally { abort.abort(); await ws.cleanup() }
  }, 15_000)
