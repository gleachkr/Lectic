import { History, historyRoot, loadHistory } from "../history"
import { expect, test } from "bun:test"
import { cp, mkdir, readFile, readdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { launchController } from "../launcher"
import { realCommand, root, workspace } from "./helpers"

for (const model of ["gpt-live-1", "gemini-3.8-live"]) {
for (const background of [false, true]) {
  test(`CLI ${model} resume and tab-close exit (background: ${background})`,
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
        const runtime = join(ws.dir, "installed")
        const plugin = join(runtime, "plugins", "lectic-live")
        await mkdir(plugin, { recursive: true })
        await cp(join(root, "extra/plugins/lectic-live"), plugin, {
          recursive: true,
        })
        const entry = join(plugin, "lectic-live.ts")
        const old = new History(ws, historyRoot(ws.env))
        old.checkpoint({ version: 1, conversationId: crypto.randomUUID(),
          incomplete: false, fragments: [{ provider: "gemini",
            sessionIdSource: "local", sessionId: "prior", sequence: 1,
            speaker: "user", text: "Saved context, not new work" }],
          tasks: [],
        })
        const args = ["-f", ws.seed, "--resume", old.id, "--model", model]
        // Exercise real shell substitution, not just reading a pipe. The
        // launcher must exit before the shell prints the captured URL.
        const command = background ? ["bash", "-c",
          'url=$("$@"); status=$?; printf "%s\\n" "$url"; exit "$status"',
          "live-test", cli, "live", ...args,
        ] : [cli, "script", entry, "--controller", ...args]
        child = Bun.spawn(command, {
          cwd: ws.cwd, env: { ...ws.env, PATH: `${bin}:${ws.env.PATH}`,
            LECTIC_RUNTIME: runtime,
            ...(model === "gpt-live-1"
              ? { OPENAI_API_KEY: "unused-no-paid-session" }
              : { GEMINI_API_KEY: "unused-no-paid-session" }),
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
        expect(diagnostics).toContain("Loaded saved conversation context")
        expect(diagnostics).toContain("Resume later with --resume")
        const ids = await readdir(historyRoot(ws.env))
        expect(ids).toHaveLength(2)
        const id = ids.find(id => id !== old.id)!
        expect(loadHistory(id, historyRoot(ws.env)))
          .toEqual(loadHistory(old.id, historyRoot(ws.env)))
        const metadata = JSON.parse(await readFile(join(
          historyRoot(ws.env), id, "session.json",
        ), "utf8"))
        expect(metadata).toMatchObject({ model, resumedFrom: old.id,
          provider: model === "gpt-live-1" ? "openai" : "gemini" })
        expect(diagnostics).not.toContain("unused-no-paid-session")
        await expect(fetch(url)).rejects.toThrow()
      } finally {
        if (url) await close().catch(() => {})
        child?.kill()
        await ws.cleanup()
      }
    }, 30_000)
}
}

test("launcher rejects failed startup instead of printing a bogus URL",
  async () => {
    await expect(launchController([process.execPath],
      ["-e", "process.exit(2)"])).rejects.toThrow("before startup")
    await expect(launchController([process.execPath],
      ["-e", "console.log('not a URL')"])).rejects.toThrow("URL")
  })
