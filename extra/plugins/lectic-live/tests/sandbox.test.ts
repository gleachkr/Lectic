import { expect, test } from "bun:test"
import { readFile, writeFile, rm } from "node:fs/promises"
import { join } from "node:path"
import { parse } from "yaml"
import {
  readOnlySandbox, checkReadOnly, validateReadOnly, probeSandbox,
} from "../sandbox"
import { runChild } from "../lectic-runner"
import { parseAndExpandCommand } from "../../../../src/utils/execHelpers"
import { realCommand, root, workspace } from "./helpers"

const example = await readFile(join(root,
  "extra/plugins/lectic-live/examples/voice-backend.lec"), "utf8")
const header = parse(example.split("---")[1])

test("example policy rejects all unsandboxed capability paths", () => {
  expect(header.sandbox).toBe(readOnlySandbox)
  validateReadOnly(header)
  for (const change of [
    { hooks: [] }, { macros: [] }, { kits: [] },
    { sandbox: "bwrap --ro-bind / /" },
    { interlocutors: [header.interlocutor] },
    { interlocutor: { ...header.interlocutor, provider: "codex" } },
    { interlocutor: { ...header.interlocutor, prompt: "exec: touch bad" } },
    { interlocutor: { ...header.interlocutor, sandbox: "env" } },
    ...[
      { mcp_command: "server" }, { native: "web_search" }, { agent: "Bot" },
      { exec: "bash", usage: "exec: touch BAD" },
      { exec: "bash", sandbox: "env" }, { exec: "bash", hooks: [] },
      { exec: "bash", env: { SECRET: "value" } },
    ].map(tool => ({ interlocutor: { ...header.interlocutor, tools: [tool] } })),
  ]) expect(() => validateReadOnly({ ...header, ...change })).toThrow()
})

test("public effective-header preserves imports and does not execute loads",
  async () => {
    const ws = await workspace()
    try {
      await writeFile(ws.seed, example)
      await rm(join(ws.cwd, "lectic.yaml"))
      const options = {
        seed: ws.seed, cwd: ws.cwd, command: realCommand, env: ws.env,
      }
      await checkReadOnly(options)
      // System inheritance must be visible even though absent from the seed.
      await writeFile(join(ws.env.LECTIC_CONFIG, "lectic.yaml"),
        'hooks:\n  - on: run_start\n    do: "touch SHOULD_NOT_RUN"\n')
      await expect(checkReadOnly(options)).rejects.toThrow()
      await rm(join(ws.env.LECTIC_CONFIG, "lectic.yaml"))
      await writeFile(ws.seed, example.replace(
        "Investigate the current repository with read-only tools. Cite paths",
        "exec: touch SHOULD_NOT_RUN",
      ))
      await expect(checkReadOnly(options)).rejects.toThrow()
      expect(await Bun.file(join(ws.cwd, "SHOULD_NOT_RUN")).exists())
        .toBe(false)
      const effective = JSON.parse(await runChild({
        command: realCommand, args: ["parse", "--effective-header", "-f",
          ws.seed], input: "", cwd: ws.cwd, env: ws.env,
      }))
      expect(effective.header.interlocutor.prompt).toStartWith("exec:")
    } finally { await ws.cleanup() }
  })

test.skipIf(process.platform !== "linux" || !Bun.which("bwrap"))(
  "real sandbox blocks host writes, hides credentials and isolates network",
  async () => {
    const ws = await workspace()
    try {
      await probeSandbox(ws.cwd)
      const marker = join(ws.cwd, "marker")
      await writeFile(marker, "unchanged")
      const secret = join(ws.dir, "private-key")
      await writeFile(secret, "private")
      const [exe, ...args] = parseAndExpandCommand(readOnlySandbox, {
        LECTIC_LIVE_WORKSPACE: ws.cwd, PATH: process.env["PATH"],
      })
      const result = await runChild({
        command: [exe], args: [...args, "bash", "--norc", "--noprofile",
          "-c", [
            `test -r ${JSON.stringify(marker)}`,
            `! (echo modified > ${JSON.stringify(marker)}) 2>/dev/null`,
            `! test -e ${JSON.stringify(secret)}`,
            'test -z "$OPENAI_API_KEY"',
            // Network namespace has no external interfaces.
            'test "$(ls /sys/class/net 2>/dev/null)" = ""',
            'echo sandbox-ok',
          ].join(" && ")],
        cwd: ws.cwd, input: "",
        env: { ...process.env, OPENAI_API_KEY: "must-not-inherit" },
      })
      expect(result.trim()).toBe("sandbox-ok")
      expect(await readFile(marker, "utf8")).toBe("unchanged")
    } finally { await ws.cleanup() }
  },
)

test.skipIf(process.platform !== "linux" || !Bun.which("bwrap"))(
  "real CLI returns a grounded result from its actual sandboxed exec tool",
  async () => {
    const { runLectic } = await import("../lectic-runner")
    const { fakeCommand } = await import("./helpers")
    const ws = await workspace()
    try {
      await rm(join(ws.cwd, "lectic.yaml"))
      await writeFile(ws.seed, example)
      await writeFile(join(ws.cwd, "evidence.txt"), "grounded-fixture")
      const env = {
        ...ws.env, SPIKE_MODE: "read-only-tool", LECTIC_LIVE_WORKSPACE: ws.cwd,
      }
      await checkReadOnly({
        seed: ws.seed, cwd: ws.cwd, command: realCommand, env,
      })
      const result = await runLectic({
        version: 1, conversationId: "c", sessionId: "s", delegationId: "d",
        offsetMs: 100,
        fragments: [{
          speaker: "user", text: "Read evidence.txt", sequence: 0,
          startMs: 0, endMs: 100,
        }],
      }, { seed: ws.seed, cwd: ws.cwd, command: fakeCommand, env })
      expect(result.summary).toContain("grounded-fixture")
      expect(await readFile(join(ws.cwd, "evidence.txt"), "utf8"))
        .toBe("grounded-fixture")
      expect(await readFile(ws.seed, "utf8")).toBe(example)
    } finally { await ws.cleanup() }
  },
)

test("workspace audit rejects pathname IPC sockets", async () => {
  const { createServer } = await import("node:net")
  const { checkWorkspace } = await import("../sandbox")
  const ws = await workspace()
  const socket = createServer()
  try {
    await new Promise<void>(resolve => socket.listen(
      join(ws.cwd, "host-control.sock"), resolve,
    ))
    await expect(checkWorkspace(ws.cwd)).rejects.toThrow("IPC socket")
  } finally {
    await new Promise<void>(resolve => socket.close(() => resolve()))
    await ws.cleanup()
  }
})
