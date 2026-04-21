import { describe, expect, test } from "bun:test"
import { join } from "path"
import * as YAML from "yaml"

import { rewriteLocalInNode } from "../../../src/utils/localPath"
import { resolveNamedUses } from "../../../src/utils/useResolver"

describe("editor plugin hook defs", () => {
  test("resolves bundled editor hook definitions", async () => {
    const raw = await Bun.file(new URL("./lectic.yaml", import.meta.url)).text()
    const parsed = rewriteLocalInNode(
      YAML.parse(raw),
      import.meta.dir
    ) as Record<string, unknown>

    const resolved = resolveNamedUses({
      ...parsed,
      hooks: [
        { use: "editor_run_progress_start" },
        { use: "editor_run_progress_end" },
        { use: "editor_tool_progress_start" },
        { use: "editor_tool_progress_end" },
        { use: "editor_approve_tools" },
      ],
    }) as { hooks?: Array<Record<string, unknown>> }

    expect(Array.isArray(resolved.hooks)).toBe(true)
    expect(resolved.hooks).toHaveLength(5)
    expect(resolved.hooks?.map((hook) => hook["name"])).toEqual([
      "editor_run_progress_start",
      "editor_run_progress_end",
      "editor_tool_progress_start",
      "editor_tool_progress_end",
      "editor_approve_tools",
    ])
    expect(resolved.hooks?.map((hook) => hook["mode"] ?? "sync")).toEqual([
      "background",
      "background",
      "background",
      "background",
      "sync",
    ])
    expect(
      resolved.hooks?.every((hook) => hook["env"] === undefined)
    ).toBe(true)
    expect(resolved.hooks?.map((hook) => hook["do"])).toEqual([
      `"${join(import.meta.dir, "scripts", "run-progress-start.ts")}"`,
      `"${join(import.meta.dir, "scripts", "run-progress-end.ts")}"`,
      `"${join(import.meta.dir, "scripts", "tool-progress-start.ts")}"`,
      `"${join(import.meta.dir, "scripts", "tool-progress-end.ts")}"`,
      `"${join(import.meta.dir, "scripts", "tool-approve.ts")}"`,
    ])
  })
})
