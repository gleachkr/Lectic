import { tmpdir } from "os"
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "fs"
import { join } from "path"
import { buildMacroIndex, previewMacro } from "./macroIndex"
import { describe, test, expect } from "bun:test"

async function withTempDir<T>(
  run: (dir: string) => Promise<T> | T
): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "lectic-lsp-test-"))
  try { return await run(dir) } finally { rmSync(dir, { recursive: true, force: true }) }
}

describe("macroIndex", () => {
  test("merge precedence and de-dup by name (case-insensitive)", async () => {
    await withTempDir(async (root) => {
      const prev = process.env["LECTIC_CONFIG"]
      try {
        const systemDir = join(root, "sys")
        const workspaceDir = join(root, "ws")
        mkdirSync(systemDir)
        mkdirSync(workspaceDir)

        // Point LECTIC_CONFIG to systemDir
        process.env["LECTIC_CONFIG"] = systemDir

        // System config
        writeFileSync(join(systemDir, "lectic.yaml"), `
macros:
  - name: A
    expansion: sys-A
  - name: B
    expansion: sys-B
`)
        // Workspace config
        writeFileSync(join(workspaceDir, "lectic.yaml"), `
macros:
  - name: A
    expansion: ws-A
  - name: C
    expansion: ws-C
`)
        // File header
        const header = `---\nmacros:\n  - name: C\n    expansion: hdr-C\n  - name: D\n    expansion: hdr-D\n---\nBody`;

        const macros = await buildMacroIndex(header, workspaceDir)

        const map = new Map(macros.map(m => [m.name, m.expansion]))
        expect(map.get("A")).toBe("ws-A") // workspace overrides system
        expect(map.get("B")).toBe("sys-B") // only in system
        expect(map.get("C")).toBe("hdr-C") // header overrides workspace
        expect(map.get("D")).toBe("hdr-D") // only in header
      } finally {
        if (prev === undefined) delete process.env["LECTIC_CONFIG"]
        else process.env["LECTIC_CONFIG"] = prev
      }
    })
  })

  test("case-insensitive de-dup keeps higher precedence", async () => {
    await withTempDir(async (root) => {
      const prev = process.env["LECTIC_CONFIG"]
      try {
        const systemDir = join(root, "sys")
        const workspaceDir = join(root, "ws")
        mkdirSync(systemDir)
        mkdirSync(workspaceDir)
        process.env["LECTIC_CONFIG"] = systemDir

        // System defines 'Summarize'
        writeFileSync(join(systemDir, "lectic.yaml"), `
macros:
  - name: Summarize
    expansion: sys
`)
        // Workspace defines 'summarize' with different expansion
        writeFileSync(join(workspaceDir, "lectic.yaml"), `
macros:
  - name: summarize
    expansion: ws
`)
        const header = `---\n---\nBody`;
        const macros = await buildMacroIndex(header, workspaceDir)
        const lower = new Map(macros.map(m => [m.name.toLowerCase(), m]))
        expect(lower.get("summarize")?.expansion).toBe("ws")
      } finally {
        if (prev === undefined) delete process.env["LECTIC_CONFIG"]
        else process.env["LECTIC_CONFIG"] = prev
      }
    })
  })

  test("previewMacro shows name and expansion excerpt", () => {
    const p1 = previewMacro({ name: "summarize", expansion: "exec:echo hi" } as any)
    expect(p1.detail).toBe("summarize")
    expect(p1.documentation).toContain("exec:")
    expect(p1.documentation).toContain("echo hi")

    const p2 = previewMacro({ name: "script", expansion:
      "exec:#!/usr/bin/env bash\necho one\necho two\n" } as any)
    expect(p2.detail).toBe("script")
    expect(p2.documentation).toContain("#!/usr/bin/env bash")
    expect(p2.documentation).toContain("echo one")

    const p3 = previewMacro({ name: "fileRef", expansion: "file:/tmp/some/path.txt" } as any)
    expect(p3.detail).toBe("fileRef")
    expect(p3.documentation).toContain("/tmp/some/path.txt")

    const p4 = previewMacro({ name: "hello", expansion: "Hello\nWorld" } as any)
    expect(p4.detail).toBe("hello")
    expect(p4.documentation).toContain("Hello")
    expect(p4.documentation).toContain("World")
  })
})
