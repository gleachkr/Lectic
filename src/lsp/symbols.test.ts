import { describe, test, expect } from "bun:test"
import { buildDocumentSymbols } from "./symbols"
import { buildTestBundle } from "./utils/testHelpers"

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
    const text = `---\ninterlocutors:\n  - name: Oggle\n    prompt: hi\nmacros:\n  - name: summarize\n    expansion: exec:echo hi\n---\nSome user text.\n\n:::Oggle\n<inline-attachment kind="attach">\n<command>date</command>\n<content type="text/plain">x</content>\n</inline-attachment>\n\n<tool-call with="get_date" kind="exec">\n<arguments></arguments>\n<results></results>\n</tool-call>\n\nHello.\n:::\n\nMore user text.\n\n:::Oggle\nBye.\n:::\n`
    const symbols = buildDocumentSymbols(text, buildTestBundle(text))
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
    const assistantCount = allNames.filter(n => n.startsWith("Oggle:")).length
    expect(assistantCount).toBe(2)
    const userCount = allNames.filter(n => n.startsWith("User:")).length
    expect(userCount >= 1).toBeTrue()

    // Tool call and inline attachment appear under the assistant message.
    expect(allNames.includes("exec: get_date")).toBeTrue()
    expect(allNames.includes("attach: date")).toBeTrue()
  })

  test("interleaved text and tool calls", () => {
    const text = `
:::Assistant
Let me check the time.

<tool-call with="date" kind="exec">
<arguments></arguments>
<results></results>
</tool-call>

Okay, I checked the time.
:::
`
    const symbols = buildDocumentSymbols(text, buildTestBundle(text))
    // Drill down to Assistant block
    const body = symbols.find(s => s.name === "Body")
    const assistant = body?.children?.find(s => s.name.startsWith("Assistant:"))
    
    expect(assistant).toBeDefined()
    const children = assistant!.children!
    expect(children.length).toBe(3)
    expect(children[0].name).toBe("Let me check the time.")
    expect(children[0].kind).toBe(15) // String
    expect(children[1].name).toBe("exec: date")
    expect(children[2].name).toBe("Okay, I checked the time.")
  })
})
