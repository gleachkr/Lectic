import { describe, test, expect } from "bun:test"
import { buildDiagnostics } from "./diagnostics"
import { tmpdir } from "os"
import { mkdtempSync, rmSync } from "fs"
import { join } from "path"

function withIsolatedSystemConfig<T>(run: (dir: string) => Promise<T> | T): Promise<T> | T {
  const prev = process.env["LECTIC_CONFIG"]
  const dir = mkdtempSync(join(tmpdir(), "lectic-lsp-diag-"))
  try {
    process.env["LECTIC_CONFIG"] = dir
    return run(dir)
  } finally {
    if (prev === undefined) delete process.env["LECTIC_CONFIG"]
    else process.env["LECTIC_CONFIG"] = prev
    rmSync(dir, { recursive: true, force: true })
  }
}

function hasMessage(diags: any[], substr: string): boolean {
  return diags.some(d => typeof d?.message === 'string' && d.message.includes(substr))
}

describe("diagnostics", () => {
  test("flags YAML/shape errors when header is invalid", async () => {
    await withIsolatedSystemConfig(async () => {
      const text = `---\n# missing interlocutor(s)\nmacros:\n  - name: x\n    expansion: y\n---\nBody\n`
      const diags = await buildDiagnostics(text, undefined)
      expect(diags.length > 0).toBeTrue()
      expect(hasMessage(diags, "YAML Header is missing")).toBeTrue()
    })
  })

  test("flags duplicate interlocutor names (case-insensitive)", async () => {
    await withIsolatedSystemConfig(async () => {
      const text = `---\ninterlocutors:\n  - name: A\n    prompt: p\n  - name: a\n    prompt: q\n---\nBody\n`
      const diags = await buildDiagnostics(text, undefined)
      expect(hasMessage(diags, "Duplicate interlocutor names")).toBeTrue()
    })
  })

  test("flags unknown :ask and :aside names in body", async () => {
    await withIsolatedSystemConfig(async () => {
      const text = `---\ninterlocutors:\n  - name: Known\n    prompt: p\n---\nBody\n:ask[Unknown]\n:aside[Nope]\n`
      const diags = await buildDiagnostics(text, undefined)
      expect(hasMessage(diags, "Unknown interlocutor in :ask")).toBeTrue()
      expect(hasMessage(diags, "Unknown interlocutor in :aside")).toBeTrue()
    })
  })

  test("flags unknown agent target", async () => {
    await withIsolatedSystemConfig(async () => {
      const text = `---\ninterlocutors:\n  - name: Main\n    prompt: p\n    tools:\n      - agent: Other\n---\nBody\n`
      const diags = await buildDiagnostics(text, undefined)
      expect(hasMessage(diags, "Agent tool references unknown interlocutor")).toBeTrue()
    })
  })
})
