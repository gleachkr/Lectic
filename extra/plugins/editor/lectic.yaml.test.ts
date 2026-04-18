import { describe, expect, test } from "bun:test"
import * as YAML from "yaml"

import { resolveNamedUses } from "../../../src/utils/useResolver"

describe("editor plugin hook defs", () => {
  test("resolves bundled editor hook definitions", async () => {
    const raw = await Bun.file(new URL("./lectic.yaml", import.meta.url)).text()
    const parsed = YAML.parse(raw) as Record<string, unknown>

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
  })
})
