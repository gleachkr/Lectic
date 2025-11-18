import { describe, test, expect } from "bun:test"
import { buildDiagnostics } from "./diagnostics"
import { remark } from "remark"
import remarkDirective from "remark-directive"

function lines(text: string): string[] { return text.split(/\r?\n/) }
function findDiag(diags: any[], substr: string) {
  return diags.find(d => typeof d?.message === 'string' && d.message.includes(substr))
}

describe("header field diagnostics", () => {
  test("missing prompt points to interlocutor mapping when absent", async () => {
    const text = `---\ninterlocutor:\n  name: A\n# no prompt\n---\nBody\n`
    const ast = remark().use(remarkDirective).parse(text)
    const diags = await buildDiagnostics(ast, text, undefined)
    const d = findDiag(diags, "needs a prompt")
    expect(d).toBeDefined()
    const ls = lines(text)
    const idx = ls.findIndex(l => l.includes("interlocutor:")) + 1 // mapping starts next line
    // name line is where mapping starts effectively; allow either
    expect(d!.range.start.line === idx || d!.range.start.line === idx + 1).toBeTrue()
  })

  test("tools wrong type points to tools value", async () => {
    const text = `---\ninterlocutor:\n  name: A\n  prompt: p\n  tools: nope\n---\nBody\n`
    const ast = remark().use(remarkDirective).parse(text)
    const diags = await buildDiagnostics(ast, text, undefined)
    const d = findDiag(diags, "tools for A need to be given in an array")
    expect(d).toBeDefined()
    const ls = lines(text)
    const idx = ls.findIndex(l => l.includes("tools: nope"))
    expect(d!.range.start.line).toBe(idx)
  })

  test("max_tokens wrong type points to its scalar value in list entry", async () => {
    const text = `---\ninterlocutors:\n  - name: Baba\n    prompt: p\n    max_tokens: "abc"\n---\nBody\n`
    const ast = remark().use(remarkDirective).parse(text)
    const diags = await buildDiagnostics(ast, text, undefined)
    const d = findDiag(diags, "max_tokens for Baba wasn't well-formed")
    expect(d).toBeDefined()
    const ls = lines(text)
    const idx = ls.findIndex(l => l.includes("max_tokens: \"abc\""))
    expect(idx).toBeGreaterThan(0)
    expect(d!.range.start.line).toBe(idx)
  })

  test("unknown interlocutor property warns on its value", async () => {
    const text = `---\ninterlocutor:\n  name: A\n  prompt: p\n  mood: cheerful\n---\nBody\n`
    const ast = remark().use(remarkDirective).parse(text)
    const diags = await buildDiagnostics(ast, text, undefined)
    const d = findDiag(diags, "Unknown property \"mood\"")
    expect(d).toBeDefined()
    const ls = lines(text)
    const idx = ls.findIndex(l => l.includes("mood: cheerful"))
    expect(idx).toBeGreaterThan(0)
    expect(d!.range.start.line).toBe(idx)
  })
})
