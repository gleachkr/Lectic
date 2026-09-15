import { expect, test } from "bun:test"
import { cp, mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { runChild } from "../lectic-runner"
import { backendPrompt } from "../prompts"
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
      const run = (command: string[]) => runChild({
        command, args: ["live", "--spike-info"],
        input: "", cwd: ws.cwd, env, timeoutMs: 30_000,
      })
      const info = JSON.parse(await run([cli]))
      expect(info.executable).toEqual([cli])
      expect(info.backendPrompt).toBe(backendPrompt)
      // Exercise the installed compiled runtime as well when available.
      const installed = Bun.which("lectic")
      if (installed) {
        // Nix wrappers prepend their bundled runtime, ahead of this test's
        // override. Use an explicit path to test this copy, not the older
        // plugin shipped with the installed executable.
        const compiledInfo = JSON.parse(await runChild({
          command: [installed],
          args: ["script", join(runtime, "lectic-live.ts"), "--spike-info"],
          input: "", cwd: ws.cwd, env, timeoutMs: 30_000,
        }))
        expect(compiledInfo.executable).toEqual([cli])
        expect(compiledInfo.backendPrompt).toBe(backendPrompt)
      }
    } finally { await ws.cleanup() }
  }, 60_000)
