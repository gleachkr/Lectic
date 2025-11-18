import { describe, test, expect } from "bun:test"
import { buildHeaderRangeIndex } from "./yamlRanges"

function lines(text: string): string[] { return text.split(/\r?\n/) }

describe("yamlRanges field mapping", () => {
  test("findRangesByPath handles interlocutors[i].max_tokens", () => {
    const text = `---\ninterlocutors:\n  - name: Baba\n    prompt: p\n    max_tokens: "abc"\n---\nBody\n`
    const idx = buildHeaderRangeIndex(text)
    expect(idx).not.toBeNull()
    const rs = idx!.findRangesByPath(["interlocutors", 0, "max_tokens"]) 
    expect(rs.length).toBe(1)
    const ls = lines(text)
    const line = ls.findIndex(l => l.includes("max_tokens: \"abc\""))
    expect(rs[0].start.line).toBe(line)
  })

  test("interlocutor mapping range end line for simple header", () => {
    const text = `---\ninterlocutor:\n  name: A\n  prompt: hi\n  \n---\nBody\n`
    const idx = buildHeaderRangeIndex(text)
    expect(idx).not.toBeNull()
    const fr = idx!.fieldRanges.find(fr => fr.path.length === 1 && fr.path[0] === 'interlocutor')
    expect(fr).toBeDefined()
    // Instrumentation: assert concrete line/character to reveal range in failure output
    expect(fr!.range.end.line).toBe(4)
    expect(fr!.range.end.character).toBe(0)
  })
})
