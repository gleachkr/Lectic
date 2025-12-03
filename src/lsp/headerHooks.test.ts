import { describe, test, expect } from "bun:test"
import { buildDiagnostics } from "./diagnostics"
import { remark } from "remark"
import remarkDirective from "remark-directive"

function lines(text: string): string[] { return text.split(/\r?\n/) }
function findDiag(diags: any[], substr: string) {
  return diags.find(d => typeof d?.message === 'string' && d.message.includes(substr))
}

describe("header field diagnostics for hooks", () => {
  test("hooks wrong type points to hooks value", async () => {
    const text = `---\ninterlocutor:\n  name: A\n  prompt: p\n  hooks: nope\n---\nBody\n`
    const ast = remark().use(remarkDirective).parse(text)
    const diags = await buildDiagnostics(ast, text, undefined)
    const d = findDiag(diags, "The hooks for A need to be given in an array")
    expect(d).toBeDefined()
    const ls = lines(text)
    const idx = ls.findIndex(l => l.includes("hooks: nope"))
    expect(d!.range.start.line).toBe(idx)
  })

  test("hook item missing fields", async () => {
    const text = `---\ninterlocutor:\n  name: A\n  prompt: p\n  hooks:\n    - on: user_message\n      # missing do\n---\nBody\n`
    const ast = remark().use(remarkDirective).parse(text)
    const diags = await buildDiagnostics(ast, text, undefined)
    const d = findDiag(diags, "Hook needs to be given with a \"do\" field")
    expect(d).toBeDefined()
    const ls = lines(text)
    const idx = ls.findIndex(l => l.includes("- on: user_message"))
    // The path points to the item, usually the start of the item
    expect(d!.range.start.line).toBeGreaterThanOrEqual(idx)
  })

  test("hook invalid event", async () => {
      const text = `---\ninterlocutor:\n  name: A\n  prompt: p\n  hooks:\n    - on: bad_event\n      do: echo\n---\nBody\n`
      const ast = remark().use(remarkDirective).parse(text)
      const diags = await buildDiagnostics(ast, text, undefined)
      const d = findDiag(diags, "Hook \"on\" needs to be one of")
      expect(d).toBeDefined()
    })
})
