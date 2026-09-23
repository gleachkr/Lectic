import { describe, expect, test } from "bun:test"
import {
  chmodSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { basename, join, resolve } from "node:path"

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

describe("lectic task project scoping", () => {
  test("default database lives under LECTIC_DATA/task", async () => {
    const root = mkdtempSync(join(tmpdir(), "lectic-task-default-db-"))

    try {
      const result = await runTask(["status", "--json"], {
        cwd: root,
        env: {
          LECTIC_DATA: root,
          LECTIC_TASK_DB: undefined,
          LECTIC_TASK_PROJECT: undefined,
        },
      })

      expect(result.exitCode).toBe(0)
      const payload = JSON.parse(result.stdout)
      expect(payload.ok).toBe(true)
      expect(payload.data.database).toBe(join(root, "task", "task.sqlite3"))
      expect(payload.data.project_key).toMatch(/^dir:/)
      expect(payload.data.project_key_source).toBe("directory")
      expect(payload.data.project).toBe(basename(root))
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("listing commands are scoped to the current project", async () => {
    const root = mkdtempSync(join(tmpdir(), "lectic-task-scope-"))

    try {
      const dbPath = join(root, "task.sqlite3")
      const inProject = (key: string, args: string[]) =>
        runTask(["--db", dbPath, "--project", key, ...args, "--json"])

      const alpha = await inProject("alpha", ["create", "--title", "Alpha task"])
      expect(alpha.exitCode).toBe(0)
      expect(JSON.parse(alpha.stdout).data.task.project_key).toBe("alpha")

      const beta = await inProject("beta", ["create", "--title", "Beta task"])
      expect(beta.exitCode).toBe(0)
      const betaId = JSON.parse(beta.stdout).data.task.id as number

      const alphaList = JSON.parse(
        (await inProject("alpha", ["list"])).stdout,
      )
      expect(alphaList.data.tasks.map((t: any) => t.title)).toEqual([
        "Alpha task",
      ])
      expect(alphaList.data.filters.all_projects).toBe(false)

      const everything = JSON.parse(
        (await inProject("alpha", ["list", "--all-projects"])).stdout,
      )
      expect(everything.data.tasks).toHaveLength(2)
      expect(everything.data.filters.all_projects).toBe(true)

      const next = JSON.parse((await inProject("beta", ["next"])).stdout)
      expect(next.data.task.title).toBe("Beta task")

      const completions = JSON.parse(
        (await inProject("beta", ["complete"])).stdout,
      )
      expect(completions.data.completions.map((c: any) => c.completion))
        .toEqual([String(betaId)])

      const todo = JSON.parse(
        (await inProject("alpha", ["render-todo"])).stdout,
      )
      expect(todo.data.markdown).toContain("Alpha task")
      expect(todo.data.markdown).not.toContain("Beta task")

      // Ids are global: a task from another project is still addressable.
      const shown = JSON.parse(
        (await inProject("alpha", ["show", String(betaId)])).stdout,
      )
      expect(shown.ok).toBe(true)
      expect(shown.data.task.project_key).toBe("beta")

      const status = JSON.parse((await inProject("alpha", ["status"])).stdout)
      expect(status.data.project_key_source).toBe("override")
      expect(status.data.project_tasks).toBe(1)
      expect(status.data.total_tasks).toBe(2)
      expect(status.data.projects).toBe(2)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("LECTIC_TASK_PROJECT overrides derived identity", async () => {
    const root = mkdtempSync(join(tmpdir(), "lectic-task-env-project-"))

    try {
      const dbPath = join(root, "task.sqlite3")
      const result = await runTask(["--db", dbPath, "status", "--json"], {
        env: { LECTIC_TASK_PROJECT: "from-env" },
      })

      expect(result.exitCode).toBe(0)
      const payload = JSON.parse(result.stdout)
      expect(payload.data.project_key).toBe("from-env")
      expect(payload.data.project_key_source).toBe("override")
      expect(payload.data.project).toBe("from-env")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("git repositories derive a stable project key", async () => {
    const root = mkdtempSync(join(tmpdir(), "lectic-task-git-project-"))

    try {
      const git = (args: string[]) => Bun.spawnSync({
        cmd: ["git", ...args],
        cwd: root,
        stdout: "pipe",
        stderr: "pipe",
      })
      expect(git(["init", "-q"]).exitCode).toBe(0)
      git(["remote", "add", "origin", "https://example.invalid/team/repo.git"])

      const dbPath = join(root, "task.sqlite3")
      const status = async () => JSON.parse((await runTask(
        ["--db", dbPath, "status", "--json"],
        { cwd: root, env: { LECTIC_TASK_PROJECT: undefined } },
      )).stdout)

      const first = await status()
      expect(first.data.project_key).toMatch(/^git:/)
      expect(first.data.project_key_source).toBe("git")
      expect(first.data.project).toBe(basename(root))
      expect((await status()).data.project_key).toBe(first.data.project_key)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe("lectic task core behaviors", () => {
  test("list --query escapes LIKE wildcards", async () => {
    const root = mkdtempSync(join(tmpdir(), "lectic-task-like-"))

    try {
      const dbPath = join(root, "task.sqlite3")
      const run = (args: string[]) =>
        runTask(["--db", dbPath, "--project", "p", ...args, "--json"])

      await run(["create", "--title", "100% done"])
      await run(["create", "--title", "100 done"])
      await run(["create", "--title", "under_score"])
      await run(["create", "--title", "underscore"])

      const percent = JSON.parse((await run(["list", "--query", "100%"])).stdout)
      expect(percent.data.tasks.map((t: any) => t.title)).toEqual(["100% done"])

      const underscore = JSON.parse(
        (await run(["list", "--query", "under_"])).stdout,
      )
      expect(underscore.data.tasks.map((t: any) => t.title))
        .toEqual(["under_score"])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("edit rejects a parent that would form a cycle", async () => {
    const root = mkdtempSync(join(tmpdir(), "lectic-task-cycle-"))

    try {
      const dbPath = join(root, "task.sqlite3")
      const run = (args: string[], env?: Record<string, string>) =>
        runTask(["--db", dbPath, "--project", "p", ...args, "--json"], { env })

      const a = JSON.parse((await run(["create", "--title", "A"])).stdout)
      const b = JSON.parse(
        (await run(["create", "--title", "B", "--parent", String(a.data.task.id)])).stdout,
      )
      expect(b.ok).toBe(true)

      // Make A's parent B: A -> B -> A.
      const editorPath = writeEditorScript(root, "editor-cycle.sh", [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        `sed -i 's/^Parent-Id:.*/Parent-Id: ${b.data.task.id}/' "$1"`,
        "",
      ].join("\n"))

      const result = JSON.parse(
        (await run(["edit", String(a.data.task.id)], { EDITOR: editorPath })).stdout,
      )
      expect(result.ok).toBe(false)
      expect(result.error.code).toBe("INVALID_ARGUMENT")
      expect(result.error.message).toContain("cycle")

      const unchanged = JSON.parse(
        (await run(["show", String(a.data.task.id)])).stdout,
      )
      expect(unchanged.data.task.parent_id).toBeNull()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("transition with note, archive, and render-todo without timestamp", async () => {
    const root = mkdtempSync(join(tmpdir(), "lectic-task-lifecycle-"))

    try {
      const dbPath = join(root, "task.sqlite3")
      const run = (args: string[]) =>
        runTask(["--db", dbPath, "--project", "p", ...args, "--json"])

      const created = JSON.parse((await run(["create", "--title", "Ship it"])).stdout)
      const id = String(created.data.task.id)

      const moved = JSON.parse(
        (await run(["transition", id, "planning", "--note", "go"])).stdout,
      )
      expect(moved.ok).toBe(true)
      expect(moved.data.task.status).toBe("planning")
      expect(moved.data.task.started_at).not.toBeNull()

      const bad = JSON.parse((await run(["transition", id, "completed"])).stdout)
      expect(bad.ok).toBe(false)
      expect(bad.error.code).toBe("INVALID_TRANSITION")

      for (const status of ["planned", "implementing", "completed"]) {
        const step = JSON.parse((await run(["transition", id, status])).stdout)
        expect(step.ok).toBe(true)
      }
      const done = JSON.parse((await run(["show", id])).stdout)
      expect(done.data.task.completed_at).not.toBeNull()
      expect(done.data.notes.map((n: any) => n.note)).toEqual(["go"])
      expect(done.data.events.map((e: any) => e.event).sort())
        .toEqual(["created", "transition", "transition", "transition", "transition"])

      const todo = JSON.parse((await run(["render-todo"])).stdout)
      expect(todo.data.markdown).toContain("Ship it")
      expect(todo.data.markdown).not.toContain("_Generated")

      const archived = JSON.parse((await run(["archive", id])).stdout)
      expect(archived.data.task.archived_at).not.toBeNull()

      const again = JSON.parse((await run(["archive", id])).stdout)
      expect(again.ok).toBe(false)
      expect(again.error.code).toBe("NOT_ALLOWED")

      const list = JSON.parse((await run(["list"])).stdout)
      expect(list.data.tasks).toHaveLength(0)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("list tolerates the empty filter values the task_list tool passes", async () => {
    const root = mkdtempSync(join(tmpdir(), "lectic-task-empty-flags-"))

    try {
      const dbPath = join(root, "task.sqlite3")
      const run = (args: string[]) =>
        runTask(["--db", dbPath, "--project", "p", ...args, "--json"])

      await run(["create", "--title", "Only"])
      const list = JSON.parse(
        (await run(["list", "--status", "", "--query", "", "--limit", "50"])).stdout,
      )
      expect(list.ok).toBe(true)
      expect(list.data.tasks.map((t: any) => t.title)).toEqual(["Only"])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
