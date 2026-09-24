import { expect, test } from "bun:test"
import { cp, mkdir, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { Script, runInNewContext } from "node:vm"
import { runChild } from "../lectic-runner"
import { realCommand, root, workspace } from "./helpers"

test("relocated installed plugin resolves embedded assets and public CLI",
  async () => {
    const ws = await workspace()
    try {
      const runtime = join(ws.dir, "installed", "plugins", "lectic-live")
      await mkdir(runtime, { recursive: true })
      await cp(join(root, "extra/plugins/lectic-live"), runtime, {
        recursive: true,
      })
      const bin = join(ws.dir, "bin")
      await mkdir(bin)
      // Public lectic executable shim for the checkout CLI, not a fake.
      const cli = join(bin, "lectic")
      await writeFile(cli, [
        '#!/bin/sh',
        `exec ${realCommand.map(s => JSON.stringify(s)).join(" ")} "$@"`,
        '',
      ].join("\n"), { mode: 0o755 })
      const env = {
        ...ws.env, PATH: `${bin}:${ws.env.PATH}`,
        LECTIC_RUNTIME: join(ws.dir, "installed"),
      }
      const probe = join(ws.dir, "resolve-cli.ts")
      await writeFile(probe, `
import { resolveLectic } from ${JSON.stringify(join(runtime,
  "lectic-runner.ts"))}
console.log(JSON.stringify(resolveLectic()))
`)
      const run = (command: string[], args: string[]) => runChild({
        command, args, input: "", cwd: ws.cwd, env, timeoutMs: 30_000,
      })
      expect(JSON.parse(await run([cli], ["script", probe])))
        .toEqual([cli])
      expect(await run([cli], ["live", "--help"]))
        .toContain("gemini-3.8-live")
      // Exercise the installed compiled runtime as well when available.
      const installed = Bun.which("lectic")
      if (installed) {
        // Nix wrappers prepend their bundled runtime, ahead of this test's
        // override. Use an explicit path to test this copy, not the older
        // plugin shipped with the installed executable.
        expect(await run([installed], ["script",
          join(runtime, "lectic-live.ts"), "--help"]))
          .toContain("gemini-3.8-live")
      }
      // Bundle the installed copy, remove its sources, then serve both
      // media variants from the relocated single file. No runtime npm build.
      const entry = join(ws.dir, "assets.ts")
      await writeFile(entry, `
import { startServer } from ${JSON.stringify(join(runtime, "server.ts"))}
const assets = []
for (const provider of ["openai", "gemini"]) {
  const server = startServer({ provider,
    connect: async () => { throw new Error("No paid calls") },
    backend: async () => { throw new Error("No backend calls") },
  })
  try {
    const app = await fetch(server.origin + "/app.js")
    const worklet = await fetch(server.origin + "/worklet.js")
    assets.push({ provider, browser: await app.text(),
      workletStatus: worklet.status, worklet: await worklet.text(),
      csp: app.headers.get("content-security-policy") })
  } finally { await server.stop() }
}
console.log(JSON.stringify(assets))
`)
      const bundle = await Bun.build({ entrypoints: [entry], target: "bun" })
      expect(bundle.success).toBe(true)
      const installedBundle = join(ws.dir, "relocated.js")
      await writeFile(installedBundle, await bundle.outputs[0].text())
      await rm(runtime, { recursive: true })
      await rm(entry)
      await rm(probe)
      const assets = JSON.parse(await runChild({
        command: [process.execPath], args: [installedBundle], input: "",
        cwd: ws.cwd, env, timeoutMs: 30000,
      }))
      expect(assets[0].workletStatus).toBe(403)
      expect(assets[1].workletStatus).toBe(200)
      expect(assets[1].csp).toContain("worker-src 'self'")
      for (const asset of assets) {
        expect(() => new Script(asset.browser)).not.toThrow()
        // Missing launch token must still evaluate without any source-tree
        // dependencies or microphone/provider access.
        expect(asset.browser).not.toContain("never-used-key")
      }
      let capture: any
      runInNewContext(assets[1].worklet, {
        AudioWorkletProcessor: class { port = {} }, sampleRate: 48000,
        registerProcessor(_name: string, value: unknown) { capture = value },
      })
      // Construction executes the embedded framer's native-rate dependency.
      expect(() => new capture()).not.toThrow()
    } finally { await ws.cleanup() }
  }, 60_000)
