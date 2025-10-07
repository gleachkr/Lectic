import { describe, test, expect } from "bun:test"
import { buildDocumentSymbols } from "./symbols"

function namesOf(ds: any[]): string[] {
  const out: string[] = []
  for (const s of ds) {
    out.push(String(s.name))
    if (Array.isArray(s.children)) out.push(...namesOf(s.children))
  }
  return out
}

describe("document symbols (unit)", () => {
  test("header groups and body blocks", () => {
    const text = `---\ninterlocutors:\n  - name: Oggle\n    prompt: hi\nmacros:\n  - name: summarize\n    expansion: exec:echo hi\n---\nSome user text.\n\n:::Oggle\nHello.\n:::\n\nMore user text.\n\n:::Oggle\nBye.\n:::\n`
    const symbols = buildDocumentSymbols(text)
    const allNames = namesOf(symbols)

    // Top-level groups
    expect(allNames.includes("Header")).toBeTrue()
    expect(allNames.includes("Body")).toBeTrue()

    // Header children
    expect(allNames.includes("Interlocutors")).toBeTrue()
    expect(allNames.includes("Macros")).toBeTrue()
    expect(allNames.includes("Oggle")).toBeTrue()
    expect(allNames.includes("summarize")).toBeTrue()

    // Body children (two assistants and at least one user chunk)
    const assistantCount = allNames.filter(n => n.startsWith("Assistant:")).length
    expect(assistantCount).toBe(2)
    const userCount = allNames.filter(n => n.startsWith("User @ line")).length
    expect(userCount >= 1).toBeTrue()
  })
})
