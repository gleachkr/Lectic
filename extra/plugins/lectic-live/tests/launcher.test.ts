import { expect, test } from "bun:test"
import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { launchController } from "../launcher"
import { realCommand, root, workspace } from "./helpers"

for (const background of [false, true]) {
  test(`CLI URL output and tab-close exit (background: ${background})`,
    async () => {
      const ws = await workspace()
      let child: Bun.Subprocess<"ignore", "pipe", "pipe"> | undefined
      let url: URL | undefined
      const close = () => fetch(new URL("/close", url), {
        method: "POST", headers: { Origin: url!.origin,
          Authorization: `Bearer ${url!.hash.slice(1)}`,
          "Content-Type": "application/json" }, body: "{}",
      })
      try {
        const bin = join(ws.dir, "bin")
        await mkdir(bin)
        const cli = join(bin, "lectic")
        await writeFile(cli, '#!/bin/sh\nexec '
          + realCommand.map(s => JSON.stringify(s)).join(" ")
          + ' "$@"\n', { mode: 0o755 })
        const entry = join(root, "extra/plugins/lectic-live/lectic-live.ts")
        const args = ["-f", ws.seed, "--keep-history"]
        // Exercise real shell substitution, not just reading a pipe. The
        // launcher must exit before the shell prints the captured URL.
        const command = background ? ["bash", "-c",
          'url=$("$@"); status=$?; printf "%s\\n" "$url"; exit "$status"',
          "live-test", cli, "live", ...args,
        ] : [cli, "script", entry, "--controller", ...args]
        child = Bun.spawn(command, {
          cwd: ws.cwd, env: { ...ws.env, PATH: `${bin}:${ws.env.PATH}`,
            LECTIC_RUNTIME: join(root, "extra"),
            OPENAI_API_KEY: "unused-no-paid-session",
          }, stdin: "ignore", stdout: "pipe", stderr: "pipe",
        })
        const stderr = new Response(child.stderr).text()
        const reader = child.stdout.getReader()
        const first = await reader.read()
        const line = new TextDecoder().decode(first.value)
        expect(line).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/#\w{64}\n$/)
        url = new URL(line.trim())
        if (background) expect(await child.exited).toBe(0)
        else expect(child.exitCode).toBeNull()
        // Serving a page must not create a paid provider session.
        expect((await fetch(url)).status).toBe(200)
        expect((await close()).status).toBe(200)
        expect(await child.exited).toBe(0)
        expect((await reader.read()).done).toBe(true)
        // EOF on inherited stderr also proves the detached controller exited.
        const diagnostics = await stderr
        expect(diagnostics).toContain("Local history:")
        expect(diagnostics).not.toContain("unused-no-paid-session")
        await expect(fetch(url)).rejects.toThrow()
      } finally {
        if (url) await close().catch(() => {})
        child?.kill()
        await ws.cleanup()
      }
    }, 30_000)
}

test("launcher rejects failed startup instead of printing a bogus URL",
  async () => {
    await expect(launchController([process.execPath],
      ["-e", "process.exit(2)"])).rejects.toThrow("before startup")
    await expect(launchController([process.execPath],
      ["-e", "console.log('not a URL')"])).rejects.toThrow("URL")
  })
