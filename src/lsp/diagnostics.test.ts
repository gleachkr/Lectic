import { describe, test, expect } from "bun:test"
import { buildDiagnostics } from "./diagnostics"
import { tmpdir } from "os"
import { mkdtempSync, rmSync, writeFileSync } from "fs"
import { join } from "path"
import { remark } from "remark"
import remarkDirective from "remark-directive"

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

function lines(text: string): string[] { return text.split(/\r?\n/) }

function diagsFor(diags: any[], substr: string) { return diags.filter(d => d.message.includes(substr)) }

describe("diagnostics", () => {
  test("flags YAML/shape errors when header is invalid", async () => {
    await withIsolatedSystemConfig(async () => {
      const text = `---\n# missing interlocutor(s)\nmacros:\n  - name: x\n    expansion: y\n---\nBody\n`
      const ast = remark().use(remarkDirective).parse(text)
      const diags = await buildDiagnostics(ast, text, undefined)
      expect(diags.length > 0).toBeTrue()
      expect(hasMessage(diags, "Header must have either")).toBeTrue()
    })
  })

  test("flags duplicate interlocutor names (case-sensitive)", async () => {
    await withIsolatedSystemConfig(async () => {
      const text = `---\ninterlocutors:\n  - name: A\n    prompt: p\n  - name: A\n    prompt: q\n---\nBody\n`
      const ast = remark().use(remarkDirective).parse(text)
      const diags = await buildDiagnostics(ast, text, undefined)
      const dups = diagsFor(diags, "Duplicate interlocutor name")
      expect(dups.length).toBe(2)
      const ls = lines(text)
      const idx1 = ls.findIndex(l => l.includes("name: A"))
      const idx2 = ls.findIndex((l, i) => i > idx1 && l.includes("name: A"))
      const starts = dups.map(d => d.range.start.line)
      expect(starts.includes(idx1)).toBeTrue()
      expect(starts.includes(idx2)).toBeTrue()
    })
  })

  test("flags duplicate interlocutor names when identical entries", async () => {
    await withIsolatedSystemConfig(async () => {
      const text = `---\ninterlocutors:\n  - name: Baba\n    prompt: Today\n  - name: Baba\n    prompt: Today\n---\nBody\n`
      const ast = remark().use(remarkDirective).parse(text)
      const diags = await buildDiagnostics(ast, text, undefined)
      const dups = diagsFor(diags, "Duplicate interlocutor name")
      expect(dups.length).toBe(2)
      const ls = lines(text)
      const idx1 = ls.findIndex(l => l.includes("name: Baba"))
      const idx2 = ls.findIndex((l, i) => i > idx1 && l.includes("name: Baba"))
      const starts = dups.map(d => d.range.start.line).sort((a,b)=>a-b)
      expect(starts[0]).toBe(idx1)
      expect(starts[1]).toBe(idx2)
    })
  })

  test("flags duplicate macro names when identical entries", async () => {
    await withIsolatedSystemConfig(async () => {
      const text = `---\nmacros:\n  - name: x\n    expansion: a\n  - name: x\n    expansion: b\n---\nBody\n`
      const ast = remark().use(remarkDirective).parse(text)
      const diags = await buildDiagnostics(ast, text, undefined)
      const dups = diagsFor(diags, "Duplicate macro name")
      expect(dups.length).toBe(2)
      const ls = lines(text)
      const idx1 = ls.findIndex(l => l.includes("name: x"))
      const idx2 = ls.findIndex((l, i) => i > idx1 && l.includes("name: x"))
      const starts = dups.map(d => d.range.start.line).sort((a,b)=>a-b)
      expect(starts[0]).toBe(idx1)
      expect(starts[1]).toBe(idx2)
    })
  })

  test("accepts macros that use pre/post without expansion", async () => {
    await withIsolatedSystemConfig(async () => {
      const text = `---\ninterlocutor:\n  name: A\n  prompt: p\nmacros:\n  - name: pre_only\n    pre: exec:echo hi\n  - name: post_only\n    post: exec:echo hi\n---\nBody\n`
      const ast = remark().use(remarkDirective).parse(text)
      const diags = await buildDiagnostics(ast, text, undefined)
      expect(hasMessage(diags, "Macro needs to be given")).toBeFalse()
    })
  })

  test("accepts hook and sandbox use refs in local header", async () => {
    await withIsolatedSystemConfig(async () => {
      const text = [
        "---",
        "hook_defs:",
        "  - name: audit",
        "    on: assistant_message",
        "    do: echo audited",
        "env_defs:",
        "  - name: base_env",
        "    env:",
        "      MODE: strict",
        "sandbox_defs:",
        "  - name: safe",
        "    sandbox: bwrap",
        "sandbox:",
        "  use: safe",
        "interlocutor:",
        "  name: A",
        "  prompt: p",
        "  sandbox:",
        "    use: safe",
        "  hooks:",
        "    - use: audit",
        "  tools:",
        "    - exec: bash",
        "      name: shell",
        "      env:",
        "        use: base_env",
        "      sandbox:",
        "        use: safe",
        "    - mcp_command: node",
        "      args:",
        "        - ./server.js",
        "      sandbox:",
        "        use: safe",
        "---",
        "Body",
        "",
      ].join("\n")

      const ast = remark().use(remarkDirective).parse(text)
      const diags = await buildDiagnostics(ast, text, undefined)
      expect(
        hasMessage(diags, "Hook needs to be given with an \"on\" field")
      ).toBeFalse()
      expect(
        hasMessage(diags, "The sandbox for A wasn't well-formed")
      ).toBeFalse()
      expect(hasMessage(diags, "'sandbox' must be a string.")).toBeFalse()
    })
  })

  test("flags invalid interlocutor and tool sandbox shapes", async () => {
    await withIsolatedSystemConfig(async () => {
      const text = [
        "---",
        "interlocutor:",
        "  name: A",
        "  prompt: p",
        "  sandbox:",
        "    bad: value",
        "  tools:",
        "    - exec: bash",
        "      name: shell",
        "      sandbox:",
        "        bad: value",
        "    - mcp_command: node",
        "      sandbox:",
        "        bad: value",
        "---",
        "Body",
        "",
      ].join("\n")

      const ast = remark().use(remarkDirective).parse(text)
      const diags = await buildDiagnostics(ast, text, undefined)

      expect(
        hasMessage(diags, "The sandbox for A wasn't well-formed")
      ).toBeTrue()
      expect(hasMessage(diags, "'sandbox' must be a string.")).toBeTrue()
    })
  })

  test("flags unknown :ask and :aside names in body", async () => {
    await withIsolatedSystemConfig(async () => {
      const text = `---\ninterlocutors:\n  - name: Known\n    prompt: p\n---\nBody\n:ask[Unknown]\n:aside[Nope]\n`
      const ast = remark().use(remarkDirective).parse(text)
      const diags = await buildDiagnostics(ast, text, undefined)
      expect(hasMessage(diags, "Unknown interlocutor in :ask")).toBeTrue()
      expect(hasMessage(diags, "Unknown interlocutor in :aside")).toBeTrue()
    })
  })

  test("ignores unknown :ask inside assistant block", async () => {
    await withIsolatedSystemConfig(async () => {
      const text = `---\ninterlocutors:\n  - name: Known\n    prompt: p\n---\n
User says something.

:::Known
Here is an inline :ask[Ghost] that should not be diagnosed.
:::
`
      const ast = remark().use(remarkDirective).parse(text)
      const diags = await buildDiagnostics(ast, text, undefined)
      expect(hasMessage(diags, "Unknown interlocutor in :ask")).toBeFalse()
    })
  })

  test("flags unknown agent target with precise range", async () => {
    await withIsolatedSystemConfig(async () => {
      const text = `---\ninterlocutors:\n  - name: Main\n    prompt: p\n    tools:\n      - agent: Other\n---\nBody\n`
      const ast = remark().use(remarkDirective).parse(text)
      const diags = await buildDiagnostics(ast, text, undefined)
      const agent = diagsFor(diags, "Agent tool references unknown interlocutor")
      expect(agent.length >= 1).toBeTrue()
      const ls = lines(text)
      const idx = ls.findIndex(l => l.includes("agent: Other"))
      expect(agent.some(d => d.range.start.line === idx)).toBeTrue()
    })
  })

  test("suppresses missing prompt when provided by workspace config", async () => {
    await withIsolatedSystemConfig(async () => {
      const ws = mkdtempSync(join(tmpdir(), "lectic-lsp-ws-"))
      try {
        // Workspace config provides the prompt for Bram
        writeFileSync(
          join(ws, "lectic.yaml"),
          `interlocutors:\n  - name: Bram\n    prompt: from workspace\n`
        )
        const text = `---\ninterlocutor:\n  name: Bram\n---\nBody\n`
        const ast = remark().use(remarkDirective).parse(text)
        const diags = await buildDiagnostics(ast, text, ws)
        expect(hasMessage(diags, "needs a prompt")).toBeFalse()
        expect(hasMessage(diags, "YAML Header is missing")).toBeFalse()
      } finally {
        rmSync(ws, { recursive: true, force: true })
      }
    })
  })

  test("does not warn duplicate interlocutor when duplicate is only from includes", async () => {
    await withIsolatedSystemConfig(async (sysDir) => {
      // System config defines Bram; local header also defines Bram once.
      writeFileSync(
        join(sysDir, "lectic.yaml"),
        `interlocutors:\n  - name: Bram\n    prompt: from system\n`
      )
      const text = `---\ninterlocutor:\n  name: Bram\n---\nBody\n`
      const ast = remark().use(remarkDirective).parse(text)
      const diags = await buildDiagnostics(ast, text, undefined)
      expect(hasMessage(diags, "Duplicate interlocutor")).toBeFalse()
    })
  })

  test("suppresses missing prompt for interlocutors[i] when provided by workspace config", async () => {
    await withIsolatedSystemConfig(async () => {
      const ws = mkdtempSync(join(tmpdir(), "lectic-lsp-ws-"))
      try {
        writeFileSync(
          join(ws, "lectic.yaml"),
          `interlocutors:\n  - name: Zoe\n    prompt: from workspace\n`
        )
        const text = `---\ninterlocutors:\n  - name: Zoe\n---\nBody\n`
        const ast = remark().use(remarkDirective).parse(text)
        const diags = await buildDiagnostics(ast, text, ws)
        expect(hasMessage(diags, "needs a prompt")).toBeFalse()
      } finally {
        rmSync(ws, { recursive: true, force: true })
      }
    })
  })

  test("warns on relative file:// URL paths", async () => {
    await withIsolatedSystemConfig(async () => {
      const text = `---\ninterlocutor:\n  name: A\n  prompt: p\n---\nSee [x](file://./alpha.txt)\n`
      const ast = remark().use(remarkDirective).parse(text)
      const diags = await buildDiagnostics(ast, text, undefined)
      expect(hasMessage(diags, "Relative paths are not allowed in file:// URLs"))
        .toBeTrue()
    })
  })
})
