import { describe, expect, test } from "bun:test"
import {
  chmodSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const repoRoot = resolve(import.meta.dir, "..", "..", "..")
const taskScriptPath = resolve(import.meta.dir, "lectic-task.ts")
const lecticMainPath = resolve(repoRoot, "src", "main.ts")

async function runTask(
  args: string[],
  options?: {
    cwd?: string
    env?: Record<string, string | undefined>
  },
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const env = {
    ...process.env,
    ...(options?.env ?? {}),
  }

  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) {
      delete env[key]
    }
  }

  const proc = Bun.spawn({
    cmd: [process.execPath, taskScriptPath, ...args],
    cwd: options?.cwd ?? repoRoot,
    env,
    stdout: "pipe",
    stderr: "pipe",
  })

  const stdout = await new Response(proc.stdout).text()
  const stderr = await new Response(proc.stderr).text()
  const exitCode = await proc.exited

  return { exitCode, stdout, stderr }
}

function writeEditorScript(root: string, name: string, body: string): string {
  const path = join(root, name)
  writeFileSync(path, body)
  chmodSync(path, 0o755)
  return path
}

async function runTaskViaLecticScript(
  args: string[],
  options?: {
    cwd?: string
    env?: Record<string, string | undefined>
  },
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const env = {
    ...process.env,
    ...(options?.env ?? {}),
  }

  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) {
      delete env[key]
    }
  }

  const proc = Bun.spawn({
    cmd: [process.execPath, lecticMainPath, "script", taskScriptPath, ...args],
    cwd: options?.cwd ?? repoRoot,
    env,
    stdout: "pipe",
    stderr: "pipe",
  })

  const stdout = await new Response(proc.stdout).text()
  const stderr = await new Response(proc.stderr).text()
  const exitCode = await proc.exited

  return { exitCode, stdout, stderr }
}

describe("lectic task editor integration", () => {
  test("plugin runs through lectic script bundling", async () => {
    const root = mkdtempSync(join(tmpdir(), "lectic-task-bundle-run-"))

    try {
      const cacheDir = join(root, "cache")
      const result = await runTaskViaLecticScript(["--help"], {
        env: {
          LECTIC_CACHE: cacheDir,
        },
      })

      expect(result.exitCode).toBe(0)
      expect(result.stderr).toBe("")
      expect(result.stdout).toContain("lectic task")
      expect(result.stdout).toContain("edit          Edit a task in $EDITOR")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("create --editor creates a task from header fields and body", async () => {
    const root = mkdtempSync(join(tmpdir(), "lectic-task-editor-create-"))

    try {
      const dbPath = join(root, "task.sqlite3")
      const editorPath = writeEditorScript(
        root,
        "editor-create.sh",
        [
          "#!/usr/bin/env bash",
          "set -euo pipefail",
          'cat <<\'EOF\' > "$1"',
          "# Create task",
          "Title: Editor-created task",
          "Status: planning",
          "Language: markdown",
          "Priority: high",
          "Effort-Hours: 2.5",
          "Parent-Id:",
          "",
          "Line one of the description.",
          "Line two of the description.",
          "EOF",
          "",
        ].join("\n"),
      )

      const result = await runTask(
        ["--db", dbPath, "create", "--editor", "--json"],
        {
          env: {
            EDITOR: editorPath,
            USER: "tester",
          },
        },
      )

      expect(result.exitCode).toBe(0)
      expect(result.stderr).toBe("")

      const payload = JSON.parse(result.stdout)
      expect(payload.ok).toBe(true)
      expect(payload.command).toBe("create")
      expect(payload.data.cancelled).toBe(false)
      expect(payload.data.task.title).toBe("Editor-created task")
      expect(payload.data.task.status).toBe("planning")
      expect(payload.data.task.language).toBe("markdown")
      expect(payload.data.task.priority).toBe("high")
      expect(payload.data.task.effort_hours).toBe(2.5)
      expect(payload.data.task.description).toBe(
        "Line one of the description.\nLine two of the description.",
      )
      expect(typeof payload.data.task.started_at).toBe("string")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("edit updates selected task from editor content", async () => {
    const root = mkdtempSync(join(tmpdir(), "lectic-task-editor-edit-"))

    try {
      const dbPath = join(root, "task.sqlite3")
      const createResult = await runTask(
        [
          "--db",
          dbPath,
          "create",
          "--title",
          "Original title",
          "--desc",
          "Original description",
          "--lang",
          "general",
          "--priority",
          "medium",
          "--json",
        ],
        {
          env: {
            USER: "tester",
          },
        },
      )

      expect(createResult.exitCode).toBe(0)
      const created = JSON.parse(createResult.stdout)
      const taskId = String(created.data.task.id)

      const editorPath = writeEditorScript(
        root,
        "editor-edit.sh",
        [
          "#!/usr/bin/env bash",
          "set -euo pipefail",
          'cat <<\'EOF\' > "$1"',
          "# Edit task",
          "Title: Revised title",
          "Status: planning",
          "Language: meta",
          "Priority: critical",
          "Effort-Hours: 4",
          "Parent-Id:",
          "",
          "Updated description from the editor.",
          "EOF",
          "",
        ].join("\n"),
      )

      const editResult = await runTask(
        ["--db", dbPath, "edit", taskId, "--json"],
        {
          env: {
            EDITOR: editorPath,
            USER: "tester",
          },
        },
      )

      expect(editResult.exitCode).toBe(0)
      expect(editResult.stderr).toBe("")

      const payload = JSON.parse(editResult.stdout)
      expect(payload.ok).toBe(true)
      expect(payload.command).toBe("edit")
      expect(payload.data.cancelled).toBe(false)
      expect(payload.data.updated).toBe(true)
      expect(payload.data.task.title).toBe("Revised title")
      expect(payload.data.task.status).toBe("planning")
      expect(payload.data.task.language).toBe("meta")
      expect(payload.data.task.priority).toBe("critical")
      expect(payload.data.task.effort_hours).toBe(4)
      expect(payload.data.task.description).toBe(
        "Updated description from the editor.",
      )

      const showResult = await runTask(
        ["--db", dbPath, "show", taskId, "--json"],
        {
          env: {
            USER: "tester",
          },
        },
      )

      expect(showResult.exitCode).toBe(0)
      const shown = JSON.parse(showResult.stdout)
      expect(
        shown.data.events.some((event: { event: string }) => {
          return event.event === "edited"
        }),
      ).toBe(true)
      expect(
        shown.data.events.some((event: { event: string }) => {
          return event.event === "transition"
        }),
      ).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
