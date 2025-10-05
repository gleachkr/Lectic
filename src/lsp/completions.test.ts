import { describe, test, expect } from "bun:test"
import { computeCompletions } from "./completions"

function hasLabel(items: any[], label: string): boolean {
  return items.some(it => it?.label === label)
}

describe("completions (unit)", () => {
  test("directive keywords on ':'", async () => {
    const text = `---\n---\n:`
    const items: any = await computeCompletions(
      "file:///doc.lec",
      text,
      { line: 2, character: 1 } as any,
      undefined
    )
    const arr = Array.isArray(items) ? items : (items?.items ?? [])
    expect(hasLabel(arr, "cmd")).toBeTrue()
    expect(hasLabel(arr, "macro")).toBeTrue()
  })

  test("inside :macro[...] suggests macro names only", async () => {
    const text = `---\nmacros:\n  - name: summarize\n    expansion: exec:echo hi\n  - name: plan\n    expansion: file:./p\n---\n:macro[su]`
    const line = text.split(/\r?\n/).length - 1
    const char = text.split(/\r?\n/)[line].length - 1
    const items: any = await computeCompletions(
      "file:///doc.lec",
      text,
      { line, character: char } as any,
      undefined
    )
    const arr = Array.isArray(items) ? items : (items?.items ?? [])
    const labels = new Set(arr.map((x: any) => x.label))
    expect(labels.has("summarize")).toBeTrue()
    expect(labels.has("plan")).toBeFalse()
  })

  test("inside :ask[...] suggests interlocutor names only", async () => {
    const text = `---\ninterlocutors:\n  - name: Boggle\n    prompt: hi\n  - name: Oggle\n    prompt: hi\n---\n:ask[Bo]`
    const line = text.split(/\r?\n/).length - 1
    const char = text.split(/\r?\n/)[line].length - 1
    const items: any = await computeCompletions(
      "file:///doc.lec",
      text,
      { line, character: char } as any,
      undefined
    )
    const arr = Array.isArray(items) ? items : (items?.items ?? [])
    const labels = new Set(arr.map((x: any) => x.label))
    expect(labels.has("Boggle")).toBeTrue()
    expect(labels.has("Oggle")).toBeFalse()
  })

  test("inside :macro[] with empty prefix suggests all macros", async () => {
    const text = `---\nmacros:\n  - name: summarize\n    expansion: exec:echo hi\n  - name: plan\n    expansion: file:./p\n---\n:macro[]`
    const lines = text.split(/\r?\n/)
    const line = lines.length - 1
    const colOpen = lines[line].indexOf(":macro[") + ":macro[".length
    const items: any = await computeCompletions(
      "file:///doc.lec",
      text,
      { line, character: colOpen } as any,
      undefined
    )
    const arr = Array.isArray(items) ? items : (items?.items ?? [])
    const labels = new Set(arr.map((x: any) => x.label))
    expect(labels.has("summarize")).toBeTrue()
    expect(labels.has("plan")).toBeTrue()
  })

  test("inside :ask[] with empty prefix suggests all interlocutors", async () => {
    const text = `---\ninterlocutors:\n  - name: Boggle\n    prompt: hi\n  - name: Oggle\n    prompt: hi\n---\n:ask[]`
    const lines = text.split(/\r?\n/)
    const line = lines.length - 1
    const colOpen = lines[line].indexOf(":ask[") + ":ask[".length
    const items: any = await computeCompletions(
      "file:///doc.lec",
      text,
      { line, character: colOpen } as any,
      undefined
    )
    const arr = Array.isArray(items) ? items : (items?.items ?? [])
    const labels = new Set(arr.map((x: any) => x.label))
    expect(labels.has("Boggle")).toBeTrue()
    expect(labels.has("Oggle")).toBeTrue()
  })
})
