import { describe, expect, test } from "bun:test"
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import * as YAML from "yaml"

import { rewriteLocalInNode } from "../../../src/utils/localPath"
import {
  LecticHeader,
  validateLecticHeaderSpec,
} from "../../../src/types/lectic"

const repoRoot = resolve(import.meta.dir, "..", "..", "..")
const scriptPath = resolve(import.meta.dir, "lectic-goal.ts")
const configPath = resolve(import.meta.dir, "lectic.yaml")

type RunOptions = {
  env?: Record<string, string | undefined>
}

type GoalRecord = {
  version: number
  revision: number
  interlocutor: string
  status: string
  goal: string
  handoff_count: number
  latest_handoff: null | {
    number: number
    session_id: string | null
    briefing: string
  }
  completion: null | {
    session_id: string | null
    summary: string
  }
}

async function runGoal(
  goalDir: string,
  args: string[],
  options?: RunOptions,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const env = {
    ...process.env,
    LECTIC_GOAL_DIR: goalDir,
    LECTIC_INTERLOCUTOR: "Assistant",
    ...(options?.env ?? {}),
  }

  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete env[key]
  }

  const proc = Bun.spawn({
    cmd: [process.execPath, scriptPath, ...args],
    cwd: repoRoot,
    env,
    stdout: "pipe",
    stderr: "pipe",
  })
  const stdout = await new Response(proc.stdout).text()
  const stderr = await new Response(proc.stderr).text()
  return { code: await proc.exited, stdout, stderr }
}

function readGoal(root: string, name = "Assistant"): GoalRecord {
  return Bun.YAML.parse(
    readFileSync(join(root, `${name}.goal`), "utf8"),
  ) as GoalRecord
}

describe("lectic goal plugin", () => {
  test("bundles as a self-contained Bun entrypoint", async () => {
    const root = mkdtempSync(join(tmpdir(), "lectic-goal-bundle-"))
    try {
      const outdir = join(root, "out")
      const result = await Bun.build({
        entrypoints: [scriptPath],
        outdir,
        target: "bun",
      })
      expect(result.success).toBe(true)

      const proc = Bun.spawn({
        cmd: [process.execPath, join(outdir, "lectic-goal.js"), "--help"],
        cwd: repoRoot,
        stdout: "pipe",
        stderr: "pipe",
      })
      const stdout = await new Response(proc.stdout).text()
      const stderr = await new Response(proc.stderr).text()
      expect(await proc.exited).toBe(0)
      expect(stderr).toBe("")
      expect(stdout).toContain("lectic goal set")
      expect(stdout).toContain("goal handoff")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("sets a YAML goal and returns workflow instructions", async () => {
    const root = mkdtempSync(join(tmpdir(), "lectic-goal-set-"))
    try {
      const result = await runGoal(root, [
        "set",
        "--goal",
        "Implement authenticated exports.",
      ])

      expect(result.code).toBe(0)
      expect(result.stderr).toBe("")
      expect(result.stdout).toContain("<persistent-goal")
      expect(result.stdout).toContain("goal_handoff")
      expect(result.stdout).toContain("goal_complete")

      const path = join(root, "Assistant.goal")
      expect(existsSync(path)).toBe(true)
      const yaml = readFileSync(path, "utf8")
      expect(yaml).toStartWith("version: 1\n")
      expect(yaml.endsWith("\n")).toBe(true)

      const goal = readGoal(root)
      expect(goal.version).toBe(1)
      expect(goal.revision).toBe(1)
      expect(goal.interlocutor).toBe("Assistant")
      expect(goal.status).toBe("active")
      expect(goal.goal).toBe("Implement authenticated exports.")
      expect(goal.handoff_count).toBe(0)
      expect(goal.latest_handoff).toBeNull()
      expect(goal.completion).toBeNull()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("refuses to replace an unfinished goal without force", async () => {
    const root = mkdtempSync(join(tmpdir(), "lectic-goal-replace-"))
    try {
      const first = await runGoal(root, [
        "set",
        "--goal",
        "First goal",
      ])
      expect(first.code).toBe(0)

      const rejected = await runGoal(root, [
        "set",
        "--goal",
        "Second goal",
      ])
      expect(rejected.code).toBe(1)
      expect(rejected.stderr).toContain("unfinished goal already exists")
      expect(readGoal(root).goal).toBe("First goal")

      const replaced = await runGoal(root, [
        "set",
        "--goal",
        "Second goal",
        "--force",
      ])
      expect(replaced.code).toBe(0)
      expect(readGoal(root).goal).toBe("Second goal")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("records a handoff in the transition tool call", async () => {
    const root = mkdtempSync(join(tmpdir(), "lectic-goal-handoff-"))
    try {
      await runGoal(root, ["set", "--goal", "Finish the parser"])
      const handoff = await runGoal(
        root,
        [
          "handoff",
          "--briefing",
          "Parser is implemented. Run the integration tests next.",
          "--json",
        ],
        { env: { RUN_ID: "run-one" } },
      )

      expect(handoff.code).toBe(0)
      expect(handoff.stderr).toBe("")
      const response = JSON.parse(handoff.stdout)
      expect(response.goal.status).toBe("ready_for_handoff")

      const goal = readGoal(root)
      expect(goal.status).toBe("ready_for_handoff")
      expect(goal.handoff_count).toBe(1)
      expect(goal.latest_handoff?.number).toBe(1)
      expect(goal.latest_handoff?.session_id).toBe("run-one")
      expect(goal.latest_handoff?.briefing).toContain("integration tests")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("final consumes a handoff and emits a successor reset", async () => {
    const root = mkdtempSync(join(tmpdir(), "lectic-goal-final-"))
    try {
      await runGoal(root, ["set", "--goal", "Finish the parser"])
      await runGoal(root, [
        "handoff",
        "--briefing",
        "Parser is implemented. Run the integration tests next.",
      ])

      const reset = await runGoal(root, ["final"])
      expect(reset.code).toBe(0)
      expect(reset.stderr).toBe("")
      expect(reset.stdout).toStartWith("LECTIC:reset\n")
      expect(reset.stdout).not.toContain("LECTIC:final")
      expect(reset.stdout).toContain("Finish the parser")
      expect(reset.stdout).toContain("Run the integration tests next")
      expect(reset.stdout).toContain("historical context")

      const goal = readGoal(root)
      expect(goal.status).toBe("active")
      expect(goal.revision).toBe(3)
      expect(goal.latest_handoff?.briefing).toContain("integration tests")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("completes a goal and lets the final response end", async () => {
    const root = mkdtempSync(join(tmpdir(), "lectic-goal-complete-"))
    try {
      await runGoal(root, ["set", "--goal", "Finish the parser"])
      const completed = await runGoal(
        root,
        [
          "complete",
          "--summary",
          "Parser and tests are complete; bun test passed.",
          "--json",
        ],
        { env: { RUN_ID: "run-two" } },
      )
      expect(completed.code).toBe(0)

      const goal = readGoal(root)
      expect(goal.status).toBe("complete")
      expect(goal.completion?.session_id).toBe("run-two")
      expect(goal.completion?.summary).toContain("bun test passed")

      const final = await runGoal(root, ["final"])
      expect(final.code).toBe(0)
      expect(final.stdout).toBe("")
      expect(final.stderr).toBe("")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("nudges active goals and eventually pauses the loop", async () => {
    const root = mkdtempSync(join(tmpdir(), "lectic-goal-nudge-"))
    try {
      await runGoal(root, ["set", "--goal", "Finish the parser"])

      const nudge = await runGoal(root, ["final"], {
        env: { FINAL_PASS_COUNT: "0" },
      })
      expect(nudge.stdout).toContain("persistent goal remains active")
      expect(nudge.stdout).not.toContain("LECTIC:final")

      const paused = await runGoal(root, ["final"], {
        env: { FINAL_PASS_COUNT: "3" },
      })
      expect(paused.stdout).toStartWith("LECTIC:final\n")
      expect(paused.stdout).toContain("automatic continuation has")
      expect(readGoal(root).status).toBe("active")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("resume injects active state without duplicating the macro", async () => {
    const root = mkdtempSync(join(tmpdir(), "lectic-goal-resume-"))
    try {
      await runGoal(root, ["set", "--goal", "Finish the parser"])

      const resumed = await runGoal(root, ["resume"])
      expect(resumed.stdout).toContain("Finish the parser")
      expect(resumed.stdout).toContain("<persistent-goal")

      const duplicate = await runGoal(root, ["resume"], {
        env: {
          USER_MESSAGE: [
            '<persistent-goal interlocutor="Assistant">',
            "Finish the parser",
          ].join("\n"),
        },
      })
      expect(duplicate.stdout).toBe("")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("resume recovers a persisted ready handoff", async () => {
    const root = mkdtempSync(join(tmpdir(), "lectic-goal-recover-"))
    try {
      await runGoal(root, ["set", "--goal", "Finish the parser"])
      await runGoal(root, [
        "handoff",
        "--briefing",
        "Continue with integration tests.",
      ])

      const resumed = await runGoal(root, ["resume"])
      expect(resumed.stdout).toContain("Continue with integration tests")
      expect(readGoal(root).status).toBe("active")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("rejects interlocutor names that can escape the goal path", async () => {
    const root = mkdtempSync(join(tmpdir(), "lectic-goal-name-"))
    try {
      const result = await runGoal(
        root,
        ["set", "--goal", "Unsafe", "--interlocutor", "../Other"],
      )
      expect(result.code).toBe(1)
      expect(result.stderr).toContain("Unsafe interlocutor name")
      expect(existsSync(join(root, "Other.goal"))).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("fails loudly on malformed goal files", async () => {
    const root = mkdtempSync(join(tmpdir(), "lectic-goal-malformed-"))
    try {
      await Bun.write(join(root, "Assistant.goal"), "status: active\n")
      const result = await runGoal(root, ["final"])
      expect(result.code).toBe(1)
      expect(result.stderr).toContain("Unsupported goal version")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("resolves the bundled config and required tool schemas", async () => {
    const raw = await Bun.file(configPath).text()
    const parsed = rewriteLocalInNode(
      YAML.parse(raw),
      import.meta.dir,
    ) as {
      kits: Array<{
        name: string
        tools: Array<{
          name: string
          env: { GOAL_PLUGIN_ROOT: string }
          schema: Record<string, unknown>
        }>
      }>
      macros: Array<{
        name: string
        env: { GOAL_PLUGIN_ROOT: string }
      }>
      hooks: Array<{
        name: string
        do: string
        env: { GOAL_PLUGIN_PATH: string }
      }>
    }

    expect(parsed.kits[0].name).toBe("goal_kit")
    expect(parsed.kits[0].tools.map(tool => tool.name)).toEqual([
      "goal_handoff",
      "goal_complete",
    ])
    expect(Object.keys(parsed.kits[0].tools[0].schema)).toEqual([
      "BRIEFING",
    ])
    expect(Object.keys(parsed.kits[0].tools[1].schema)).toEqual([
      "SUMMARY",
    ])
    expect(
      parsed.kits[0].tools.every(tool => {
        return tool.env.GOAL_PLUGIN_ROOT === import.meta.dir
      }),
    ).toBe(true)
    expect(parsed.macros[0].env.GOAL_PLUGIN_ROOT).toBe(import.meta.dir)
    expect(parsed.hooks.map(hook => hook.do)).toEqual([
      '"$GOAL_PLUGIN_PATH" resume',
      '"$GOAL_PLUGIN_PATH" final',
    ])
    expect(
      parsed.hooks.every(hook => {
        return hook.env.GOAL_PLUGIN_PATH === scriptPath
      }),
    ).toBe(true)

    const spec = {
      ...parsed,
      interlocutor: {
        name: "Assistant",
        prompt: "Test prompt",
        tools: [{ kit: "goal_kit" }],
      },
    }
    expect(() => validateLecticHeaderSpec(spec)).not.toThrow()

    const header = new LecticHeader(spec)
    await header.initialize()
    expect(Object.keys(header.interlocutor.registry ?? {})).toEqual([
      "goal_handoff",
      "goal_complete",
    ])
  })
})
