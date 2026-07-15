import { describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import * as YAML from "yaml"

import { rewriteLocalInNode } from "../../../src/utils/localPath"
import { memorySearchScore } from "./memory-browser-search"

const repoRoot = resolve(import.meta.dir, "..", "..", "..")
const scriptPath = resolve(import.meta.dir, "lectic-memory.ts")

type RunOptions = {
  env?: Record<string, string | undefined>
}

async function runMemory(
  dbPath: string,
  args: string[],
  options?: RunOptions,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const env = { ...process.env, ...(options?.env ?? {}) }
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete env[key]
  }
  const command = [process.execPath, scriptPath, "--db", dbPath, ...args]
  const proc = Bun.spawn({
    cmd: command,
    cwd: repoRoot,
    env,
    stdout: "pipe",
    stderr: "pipe",
  })
  const stdout = await new Response(proc.stdout).text()
  const stderr = await new Response(proc.stderr).text()
  return { code: await proc.exited, stdout, stderr }
}

function payload(stdout: string): any {
  return JSON.parse(stdout)
}

describe("lectic memory plugin", () => {
  test("bundles as a self-contained Bun entrypoint", async () => {
    const root = mkdtempSync(join(tmpdir(), "lectic-memory-bundle-"))
    try {
      const outdir = join(root, "out")
      const result = await Bun.build({
        entrypoints: [scriptPath],
        outdir,
        target: "bun",
      })
      expect(result.success).toBe(true)

      const proc = Bun.spawn({
        cmd: [
          process.execPath,
          join(outdir, "lectic-memory.js"),
          "--db",
          join(root, "memory.sqlite3"),
          "--help",
        ],
        cwd: repoRoot,
        stdout: "pipe",
        stderr: "pipe",
      })
      const stdout = await new Response(proc.stdout).text()
      const stderr = await new Response(proc.stderr).text()
      expect(await proc.exited).toBe(0)
      expect(stderr).toBe("")
      expect(stdout).toContain("lectic memory")
      expect(stdout).toContain("browse")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("scores browser searches across content and metadata", () => {
    const memory = {
      id: 7,
      scope: "project",
      kind: "procedure",
      gist: "Generate fixtures before parser tests.",
      content: "Run bun scripts/generate-fixtures.ts first.",
      source_file: "/tmp/parser.lec",
      source_interlocutor: "Assistant",
      status: "active",
    }

    expect(memorySearchScore(memory, "fixtures parser")).toBe(24)
    expect(memorySearchScore(memory, "generate-fixtures")).toBe(5)
    expect(memorySearchScore(memory, "procedure")).toBe(3)
    expect(memorySearchScore(memory, "migration")).toBe(-1)
  })

  test("stores memories and briefs with recent gists", async () => {
    const root = mkdtempSync(join(tmpdir(), "lectic-memory-gist-"))
    const db = join(root, "memory.sqlite3")
    try {
      const first = await runMemory(db, [
        "--project",
        "project-a",
        "add",
        "--gist",
        "Use Bun for project scripts.",
        "--content",
        "The verified test command is bun test.",
        "--kind",
        "project-fact",
      ])
      expect(first.code).toBe(0)
      expect(payload(first.stdout).data.id).toBe(1)

      const user = await runMemory(db, [
        "--project",
        "project-a",
        "add",
        "--scope",
        "user",
        "--gist",
        "The user prefers concise status reports.",
        "--content",
        "Keep routine progress reports short.",
        "--kind",
        "preference",
      ])
      expect(user.code).toBe(0)

      const other = await runMemory(db, [
        "--project",
        "project-b",
        "add",
        "--gist",
        "This belongs only to project B.",
        "--content",
        "Project B detail.",
      ])
      expect(other.code).toBe(0)

      const briefing = await runMemory(db, [
        "--project",
        "project-a",
        "briefing",
      ])
      expect(briefing.stdout).toContain("Use Bun for project scripts.")
      expect(briefing.stdout).toContain("prefers concise status reports")
      expect(briefing.stdout).not.toContain("belongs only to project B")
      expect(briefing.stdout).not.toContain("verified test command")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("waits for concurrent database writers", async () => {
    const root = mkdtempSync(join(tmpdir(), "lectic-memory-lock-"))
    const dbPath = join(root, "memory.sqlite3")
    let blocker: Database | null = null

    try {
      const add = await runMemory(dbPath, [
        "--project",
        "p",
        "add",
        "--gist",
        "A memory retrieved while another writer is active.",
        "--content",
        "The get command should wait before updating access metadata.",
      ])
      expect(add.code).toBe(0)

      blocker = new Database(dbPath)
      blocker.exec("BEGIN IMMEDIATE")

      const pendingGet = runMemory(dbPath, ["--project", "p", "get", "1"])
      await Bun.sleep(250)
      blocker.exec("COMMIT")

      const get = await pendingGet
      expect(get.code).toBe(0)
      expect(get.stderr).toBe("")
      expect(payload(get.stdout).data.access_count).toBe(1)
    } finally {
      if (blocker) {
        try {
          blocker.exec("ROLLBACK")
        } catch {
          // The successful path already committed the transaction.
        }
        blocker.close(false)
      }
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("searches, updates, and forgets by exact id", async () => {
    const root = mkdtempSync(join(tmpdir(), "lectic-memory-crud-"))
    const db = join(root, "memory.sqlite3")
    try {
      await runMemory(db, [
        "--project",
        "p",
        "add",
        "--gist",
        "Parser failures require the fixture generator.",
        "--content",
        "Run bun scripts/generate-fixtures.ts before parser tests.",
        "--kind",
        "procedure",
      ])
      const search = await runMemory(db, [
        "--project",
        "p",
        "search",
        "fixture parser",
      ])
      expect(search.code).toBe(0)
      expect(payload(search.stdout).data.memories).toHaveLength(1)

      const update = await runMemory(db, [
        "--project",
        "p",
        "update",
        "1",
        "--gist",
        "Generate fixtures before running parser tests.",
      ])
      expect(update.code).toBe(0)
      expect(payload(update.stdout).data.gist).toStartWith("Generate")

      const forget = await runMemory(db, [
        "--project",
        "p",
        "forget",
        "1",
      ])
      expect(forget.code).toBe(0)
      const list = await runMemory(db, ["--project", "p", "list"])
      expect(payload(list.stdout).data.memories).toHaveLength(0)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test(
    "records searchable history without structured transcript blocks",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "lectic-memory-history-"))
      const db = join(root, "memory.sqlite3")
      try {
      const record = await runMemory(
        db,
        ["--project", "p", "record"],
        {
          env: {
            LECTIC_FILE: join(root, "chat.lec"),
            LECTIC_INTERLOCUTOR: "Assistant",
            ASSISTANT_MESSAGE: [
              "The migration failed because the index was stale.",
              "<tool-call with=\"shell\">secret tool output</tool-call>",
              "<private>api-key</private>",
            ].join("\n"),
            USER_MESSAGE: undefined,
          },
        },
      )
      expect(record.code).toBe(0)
      expect(payload(record.stdout).data.recorded).toBe(true)

      const search = await runMemory(db, [
        "--project",
        "p",
        "history",
        "stale migration index",
      ])
      const messages = payload(search.stdout).data.messages
      expect(messages).toHaveLength(1)
      expect(messages[0].content).toContain("migration failed")
      expect(messages[0].content).not.toContain("secret tool output")
      expect(messages[0].content).not.toContain("api-key")
      expect(messages[0].content).toContain("[private omitted]")
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    },
  )

  test("plugin config defines hooks and exposes an opt-in kit", async () => {
    const text = await Bun.file(
      new URL("./lectic.yaml", import.meta.url),
    ).text()
    const config = rewriteLocalInNode(
      YAML.parse(text),
      import.meta.dir,
    ) as {
      kits: Array<{
        name: string
        tools: Array<{ name: string; exec: string; usage: string }>
      }>
      hook_defs: Array<{
        name: string
        on: string
        inline?: boolean
        do: string
      }>
    }
    expect(config.kits[0].name).toBe("memory_kit")
    expect(config.kits[0].tools[0].name).toBe("memory")
    expect(config.kits[0].tools[0].exec).toBe(`"${scriptPath}"`)
    expect(config.kits[0].tools[0].usage).toBe(
      `file:${join(import.meta.dir, "prompt.md")}`,
    )
    expect(config.hook_defs.map((hook) => hook.name)).toEqual([
      "memory_record_user",
      "memory_record_assistant",
      "memory_briefing",
    ])
    expect(config.hook_defs[2].on).toBe("user_first")
    expect(config.hook_defs[2].inline).toBe(true)
    expect(config.hook_defs.every((hook) => {
      return !hook.do.includes("local:")
    })).toBe(true)
  })
})
