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

  test("local:./x rewrites to absolute path", async () => {
    const root = mkdtempSync(join(tmpdir(), "lectic-config-local-abs-"))
    const pluginDir = join(root, "plugin")

    try {
      mkdirSync(pluginDir, { recursive: true })
      writeFileSync(
        join(pluginDir, "module.yaml"),
        [
          "interlocutor:",
          "  name: Imported",
          "  prompt: local:./prompt.md",
          "",
        ].join("\n")
      )

      const out = await resolveConfigChain({
        includeSystem: false,
        document: {
          yaml: [
            "imports:",
            "  - ./plugin/module.yaml",
            "interlocutor:",
            "  name: Imported",
            "",
          ].join("\n"),
          dir: root,
        },
      })

      expect(out.issues).toHaveLength(0)
      const modulePath = join(pluginDir, "module.yaml")
      const source = out.sources.find(s => s.path === modulePath)
      const prompt = (
        source?.parsed as { interlocutor?: { prompt?: string } } | undefined
      )?.interlocutor?.prompt

      expect(prompt).toBe(join(pluginDir, "prompt.md"))
      expect(source?.text).toContain(join(pluginDir, "prompt.md"))
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("file:local:./x rewrites to file:/abs/x", async () => {
    const root = mkdtempSync(join(tmpdir(), "lectic-config-file-local-"))

    try {
      writeFileSync(
        join(root, "module.yaml"),
        [
          "interlocutor:",
          "  name: Imported",
          "  prompt: file:local:./prompt.md",
          "",
        ].join("\n")
      )

      const out = await resolveConfigChain({
        includeSystem: false,
        document: {
          yaml: [
            "imports:",
            "  - ./module.yaml",
            "interlocutor:",
            "  name: Imported",
            "",
          ].join("\n"),
          dir: root,
        },
      })

      expect(out.issues).toHaveLength(0)
      const source = out.sources.find(s => s.path === join(root, "module.yaml"))
      const prompt = (
        source?.parsed as { interlocutor?: { prompt?: string } } | undefined
      )?.interlocutor?.prompt

      expect(prompt).toBe(`file:${join(root, "prompt.md")}`)
      expect(source?.text).toContain(`file:${join(root, "prompt.md")}`)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("sqlite init_sql supports file:local: paths", async () => {
    const root = mkdtempSync(join(tmpdir(), "lectic-config-sqlite-local-"))

    try {
      writeFileSync(
        join(root, "module.yaml"),
        [
          "interlocutor:",
          "  name: Imported",
          "  prompt: p",
          "  tools:",
          "    - sqlite: ./plugin.sqlite",
          "      name: db",
          "      init_sql: file:local:./schema.sql",
          "",
        ].join("\n")
      )

      const out = await resolveConfigChain({
        includeSystem: false,
        document: {
          yaml: [
            "imports:",
            "  - ./module.yaml",
            "interlocutor:",
            "  name: Imported",
            "",
          ].join("\n"),
          dir: root,
        },
      })

      expect(out.issues).toHaveLength(0)
      const source = out.sources.find(s => s.path === join(root, "module.yaml"))
      const initSql = (
        source?.parsed as {
          interlocutor?: { tools?: Array<{ init_sql?: string }> }
        } | undefined
      )?.interlocutor?.tools?.[0]?.init_sql

      expect(initSql).toBe(`file:${join(root, "schema.sql")}`)
      expect(source?.text).toContain(`file:${join(root, "schema.sql")}`)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("output_schema supports file:local: paths", async () => {
    const root = mkdtempSync(join(tmpdir(), "lectic-config-schema-local-"))

    try {
      writeFileSync(
        join(root, "module.yaml"),
        [
          "interlocutor:",
          "  name: Imported",
          "  prompt: p",
          "  output_schema: file:local:./schema.json",
          "",
        ].join("\n")
      )

      const out = await resolveConfigChain({
        includeSystem: false,
        document: {
          yaml: [
            "imports:",
            "  - ./module.yaml",
            "interlocutor:",
            "  name: Imported",
            "",
          ].join("\n"),
          dir: root,
        },
      })

      expect(out.issues).toHaveLength(0)
      const source = out.sources.find(s => s.path === join(root, "module.yaml"))
      const outputSchema = (
        source?.parsed as {
          interlocutor?: { output_schema?: string }
        } | undefined
      )?.interlocutor?.output_schema

      expect(outputSchema).toBe(`file:${join(root, "schema.json")}`)
      expect(source?.text).toContain(`file:${join(root, "schema.json")}`)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("nested local imports resolve relative to each source file", async () => {
    const root = mkdtempSync(join(tmpdir(), "lectic-config-local-nested-"))
    const pluginsDir = join(root, "plugins")
    const modulesDir = join(root, "modules")

    try {
      mkdirSync(pluginsDir, { recursive: true })
      mkdirSync(join(modulesDir, "prompts"), { recursive: true })

      writeFileSync(
        join(root, "lectic.yaml"),
        [
          "imports:",
          "  - ./plugins/first.yaml",
          "interlocutor:",
          "  name: First",
          "",
        ].join("\n")
      )

      writeFileSync(
        join(pluginsDir, "first.yaml"),
        [
          "imports:",
          "  - local:../modules/second.yaml",
          "interlocutor:",
          "  name: First",
          "  prompt: local:./first.md",
          "",
        ].join("\n")
      )

      writeFileSync(
        join(modulesDir, "second.yaml"),
        [
          "macros:",
          "  - name: from_second",
          "    expansion: local:./prompts/second.md",
          "",
        ].join("\n")
      )

      const out = await resolveConfigChain({
        includeSystem: false,
        workspaceStartDir: root,
      })

      expect(out.issues).toHaveLength(0)

      const first = out.sources.find(s => s.path === join(pluginsDir, "first.yaml"))
      const second = out.sources.find(s => s.path === join(modulesDir, "second.yaml"))

      const firstPrompt = (
        first?.parsed as { interlocutor?: { prompt?: string } } | undefined
      )?.interlocutor?.prompt
      const secondExpansion = (
        second?.parsed as { macros?: Array<{ expansion?: string }> } | undefined
      )?.macros?.[0]?.expansion

      expect(firstPrompt).toBe(join(pluginsDir, "first.md"))
      expect(secondExpansion).toBe(join(modulesDir, "prompts", "second.md"))
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("imports.path supports local:./module.yaml", async () => {
    const root = mkdtempSync(join(tmpdir(), "lectic-config-import-local-"))

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
            "  - path: local:./module.yaml",
            "interlocutor:",
            "  name: Doc",
            "  prompt: p",
            "",
          ].join("\n"),
          dir: root,
        },
      })

      expect(out.issues).toHaveLength(0)
      expect(out.sources.map(s => s.path)).toContain(join(root, "module.yaml"))
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("invalid local: forms produce deterministic errors", async () => {
    const root = mkdtempSync(join(tmpdir(), "lectic-config-local-errors-"))

    try {
      const cases = [
        {
          value: "local:foo/bar",
          message: "local: paths must start with ./ or ../",
        },
        {
          value: "local:/abs",
          message: "local: paths must start with ./ or ../",
        },
        {
          value: "local:exec:echo hi",
          message: "local: does not compose with exec:",
        },
        {
          value: "local:file:./x",
          message: "use file:local:./... instead of local:file:...",
        },
      ]

      for (const testCase of cases) {
        const out = await resolveConfigChain({
          includeSystem: false,
          document: {
            yaml: [
              "interlocutor:",
              "  name: Doc",
              `  prompt: ${testCase.value}`,
              "",
            ].join("\n"),
            dir: root,
          },
        })

        expect(out.issues).toHaveLength(1)
        expect(out.issues[0].phase).toBe("import")
        expect(out.issues[0].source).toBe("document")
        expect(out.issues[0].message).toBe(testCase.message)
      }
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
