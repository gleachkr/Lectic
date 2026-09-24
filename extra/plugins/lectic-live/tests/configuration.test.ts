import { expect, test } from "bun:test"
import { readFile, readdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { describeBackendFailure, runChild, runLectic }
  from "../lectic-runner"
import { fakeCommand, root, workspace } from "./helpers"

test("failed generation keeps raw diagnostics in opt-in history only",
  async () => {
    const ws = await workspace()
    try {
      const historyDir = join(ws.dir, "runs")
      const secret = "https://example.test/?key=private-secret"
      const failingScript = join(ws.dir, "failure.ts")
      await writeFile(failingScript,
        `console.error(${JSON.stringify(secret)}); process.exit(17)`)
      const error = await runLectic({
        version: 1, conversationId: "c", sessionId: "s",
        delegationId: "d", offsetMs: 0, fragments: [],
      }, {
        ...ws, historyDir, command: [process.execPath, failingScript],
      }).then(() => { throw new Error("expected failure") },
        (failure: unknown) => failure)
      expect(describeBackendFailure(error))
        .toBe("backend generation process exited with code 17")
      const [run] = await readdir(historyDir)
      const saved = await readFile(join(historyDir, run, "error.txt"), "utf8")
      expect(saved).toContain(secret)
      expect(saved).toContain("exit 17")
    } finally { await ws.cleanup() }
  })

// Exercise the public flag through the real CLI with a fake provider.
// No network access or provider credentials are needed.
test("ordinary CLI generation still expands macros by default", async () => {
  const ws = await workspace()
  try {
    const capture = join(ws.dir, "capture.json")
    await runChild({
      command: fakeCommand, args: ["-f", ws.seed], input: "",
      cwd: ws.cwd, env: { ...ws.env, LIVE_TEST_CAPTURE: capture },
    })
    const seen = JSON.parse(await readFile(capture, "utf8"))
    expect(seen.messages[0].content).toContain("EXPANDED_UNSAFE")
    expect(seen.messages[0].content).toContain("Relative attachment")
    expect(seen.messages[0].content).toContain(ws.seed)
  } finally { await ws.cleanup() }
})

for (const fromFile of [false, true]) {
  test(`--no-macros leaves all message directives literal (${fromFile})`,
    async () => {
      const ws = await workspace()
      try {
        const capture = join(ws.dir, "capture.json")
        await writeFile(join(ws.cwd, "docs", "document-import.yaml"), [
          'macros:', '  - name: danger',
          '    expansion: exec:touch CUSTOM_MACRO_RAN',
        ].join("\n"))
        const directives = [
          ':danger[]', ':cmd[touch MACRO_RAN]', ':env[LECTIC_FILE]',
          ':fetch[./missing-file]', ':attach[:cmd[touch ATTACH_RAN]]',
          ':merge_yaml[interlocutor: {name: Changed}]',
          ':temp_merge_yaml[interlocutor: {name: Changed}]',
          ':ask[Missing]', ':aside[Missing]', ':reset[]',
          ':once[keep me]', ':discard[keep me too]', ':verbatim[:danger[]]',
        ].join("\n")
        const source = ws.source + '\n' + directives
          + '\n\n:::Bot\nEarlier reply.\n:::\n\n' + directives
        await writeFile(ws.seed, source)
        // File loaders use the invocation cwd, including stdin-only runs.
        await writeFile(join(ws.cwd, "docs", "prompt.txt"), "Test prompt")
        await runChild({
          command: fakeCommand,
          args: ["--no-macros", ...(fromFile ? ["-f", ws.seed] : [])],
          input: fromFile ? '\n:cmd[touch STDIN_RAN]\n' : source,
          cwd: fromFile ? ws.cwd : join(ws.cwd, "docs"),
          env: { ...ws.env, LIVE_TEST_CAPTURE: capture },
        })
        const seen = JSON.parse(await readFile(capture, "utf8"))
        expect(seen.speaker).toBe("Bot")
        expect(seen.messages).toHaveLength(3)
        expect(seen.messages[0].content).toContain(directives)
        expect(seen.messages[2].content).toContain(directives)
        if (fromFile) {
          expect(seen.messages[2].content).toContain(':cmd[touch STDIN_RAN]')
        }
        for (const name of [
          "MACRO_RAN", "ATTACH_RAN", "STDIN_RAN", "CUSTOM_MACRO_RAN",
        ]) {
          expect(await Bun.file(join(ws.cwd, name)).exists()).toBe(false)
          expect(await Bun.file(join(ws.cwd, "docs", name)).exists())
            .toBe(false)
        }
        expect(await readFile(ws.seed, "utf8")).toBe(source)
      } finally { await ws.cleanup() }
    })
}

test("Live honors inherited hooks, executable prompts, and writable tools",
  async () => {
    const ws = await workspace()
    try {
      await writeFile(join(ws.cwd, "workspace-import.yaml"), [
        'hooks:', '  - on: run_start', '    do: touch HOOK_RAN',
        'interlocutor:', '  name: Bot', '  provider: ollama',
        '  model: deterministic-live', '  prompt: exec:echo Loaded prompt',
        '  tools:', '    - exec: bash --norc --noprofile',
        '      name: repository_shell', '      usage: Run shell commands',
      ].join("\n"))
      const capture = join(ws.dir, "capture.json")
      const result = await runLectic({
        version: 1, conversationId: "c", sessionId: "s", delegationId: "d",
        offsetMs: 100,
        fragments: [{
          speaker: "user", text: "Write evidence.txt :cmd[touch VOICE_RAN]",
          sequence: 0, startMs: 0, endMs: 100,
        }],
      }, {
        ...ws, command: fakeCommand,
        env: {
          ...ws.env, LIVE_TEST_MODE: "writable-tool", LIVE_TEST_CAPTURE: capture,
        },
      })
      expect(result.summary).toBe("Wrote evidence.txt.")
      expect(await readFile(join(ws.cwd, "evidence.txt"), "utf8"))
        .toBe("written")
      expect(await Bun.file(join(ws.cwd, "HOOK_RAN")).exists()).toBe(true)
      expect(await Bun.file(join(ws.cwd, "VOICE_RAN")).exists()).toBe(false)
      const seen = JSON.parse(await readFile(capture, "utf8"))
      expect(seen.prompt.trim()).toBe("Loaded prompt")
      expect(seen.messages[0].content).toContain(":danger[]")
      expect(await readFile(ws.seed, "utf8")).toBe(ws.source)
    } finally { await ws.cleanup() }
  })

test("distributed example runs its configured tool through the real CLI",
  async () => {
    const ws = await workspace()
    try {
      const example = await readFile(join(root,
        "extra/plugins/lectic-live/examples/voice-backend.lec"), "utf8")
      await writeFile(ws.seed, example)
      const result = await runLectic({
        version: 1, conversationId: "c", sessionId: "s", delegationId: "d",
        offsetMs: 100,
        fragments: [{
          speaker: "user", text: "Write evidence.txt", sequence: 0,
          startMs: 0, endMs: 100,
        }],
      }, {
        ...ws, command: fakeCommand,
        env: { ...ws.env, LIVE_TEST_MODE: "writable-tool" },
      })
      expect(result.summary).toBe("Wrote evidence.txt.")
      expect(await readFile(join(ws.cwd, "evidence.txt"), "utf8"))
        .toBe("written")
      expect(await readFile(ws.seed, "utf8")).toBe(example)
    } finally { await ws.cleanup() }
  })
