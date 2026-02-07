import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"

import {
  findWorkspaceConfigPath,
  resolveConfigChain,
} from "./configDiscovery"

describe("config discovery", () => {
  test("findWorkspaceConfigPath walks up to lectic.yaml", async () => {
    const root = mkdtempSync(join(tmpdir(), "lectic-config-walk-"))
    const nested = join(root, "a", "b", "c")

    try {
      writeFileSync(join(root, "lectic.yaml"), "interlocutor:\n  name: A\n")
      mkdirSync(nested, { recursive: true })

      const found = await findWorkspaceConfigPath(nested)
      expect(found).toBe(join(root, "lectic.yaml"))
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("resolveConfigChain expands workspace imports in order", async () => {
    const root = mkdtempSync(join(tmpdir(), "lectic-config-chain-"))
    const nested = join(root, "x", "y")

    try {
      mkdirSync(nested, { recursive: true })

      writeFileSync(
        join(root, "lectic.yaml"),
        [
          "imports:",
          "  - ./a.yaml",
          "interlocutor:",
          "  name: Root",
          "  prompt: root",
          "",
        ].join("\n")
      )

      writeFileSync(
        join(root, "a.yaml"),
        [
          "imports:",
          "  - ./b.yaml",
          "macros:",
          "  - name: from_a",
          "    expansion: from a",
          "",
        ].join("\n")
      )

      writeFileSync(
        join(root, "b.yaml"),
        ["interlocutor:", "  name: Base", "  prompt: base", ""].join("\n")
      )

      const out = await resolveConfigChain({
        includeSystem: false,
        workspaceStartDir: nested,
      })

      expect(out.issues.length).toBe(0)
      const paths = out.sources.map(s => s.path)
      expect(paths).toEqual([
        join(root, "b.yaml"),
        join(root, "a.yaml"),
        join(root, "lectic.yaml"),
      ])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("resolveConfigChain expands document imports", async () => {
    const root = mkdtempSync(join(tmpdir(), "lectic-config-doc-"))

    try {
      writeFileSync(
        join(root, "module.yaml"),
        ["macros:", "  - name: helper", "    expansion: hi", ""].join("\n")
      )

      const out = await resolveConfigChain({
        includeSystem: false,
        document: {
          yaml: [
            "imports:",
            "  - ./module.yaml",
            "interlocutor:",
            "  name: Doc",
            "  prompt: p",
            "",
          ].join("\n"),
          dir: root,
        },
      })

      expect(out.issues.length).toBe(0)
      expect(out.sources.map(s => s.source)).toEqual(["import", "document"])
      expect(out.sources[0].path).toBe(join(root, "module.yaml"))
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("directory imports resolve to <dir>/lectic.yaml", async () => {
    const root = mkdtempSync(join(tmpdir(), "lectic-config-dir-import-"))
    const pluginDir = join(root, "plugins", "sales")

    try {
      mkdirSync(pluginDir, { recursive: true })
      writeFileSync(
        join(pluginDir, "lectic.yaml"),
        ["macros:", "  - name: from_plugin", "    expansion: ok", ""].join(
          "\n"
        )
      )

      const out = await resolveConfigChain({
        includeSystem: false,
        document: {
          yaml: [
            "imports:",
            "  - ./plugins/sales",
            "interlocutor:",
            "  name: Doc",
            "  prompt: p",
            "",
          ].join("\n"),
          dir: root,
        },
      })

      expect(out.issues.length).toBe(0)
      expect(out.sources.map(s => s.source)).toEqual(["import", "document"])
      expect(out.sources[0].path).toBe(join(pluginDir, "lectic.yaml"))
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("resolveConfigChain reports import cycles", async () => {
    const root = mkdtempSync(join(tmpdir(), "lectic-config-cycle-"))

    try {
      writeFileSync(
        join(root, "lectic.yaml"),
        ["imports:", "  - ./a.yaml", "interlocutor:", "  name: A", ""].join(
          "\n"
        )
      )
      writeFileSync(join(root, "a.yaml"), "imports:\n  - ./b.yaml\n")
      writeFileSync(join(root, "b.yaml"), "imports:\n  - ./a.yaml\n")

      const out = await resolveConfigChain({
        includeSystem: false,
        workspaceStartDir: root,
      })

      expect(
        out.issues.some(
          issue =>
            issue.phase === "import" &&
            issue.message.includes("import cycle detected")
        )
      ).toBeTrue()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
