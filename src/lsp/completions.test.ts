import { describe, test, expect } from "bun:test"
import { computeCompletions } from "./completions"
import { buildTestBundle } from "./utils/testHelpers"
import { INTERLOCUTOR_KEYS } from "./interlocutorFields"
import { LLMProvider } from "../types/provider"
import { InsertTextFormat } from "vscode-languageserver/node"
import { mkdtemp, writeFile, rm } from "fs/promises"
import { tmpdir } from "os"
import { join } from "path"

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
      undefined,
      buildTestBundle(text)
    )
    const arr = Array.isArray(items) ? items : (items?.items ?? [])
    expect(hasLabel(arr, "cmd")).toBeTrue()
    expect(hasLabel(arr, "macro")).toBeFalse()
  })

  test("tools array suggests tool kinds after '-' with no key yet", async () => {
    const text = `---\ninterlocutor:\n  name: A\n  prompt: hi\n  tools:\n    - \n---\n`
    const line = 5
    const char = text.split(/\r?\n/)[line].length
    const items: any = await computeCompletions(
      "file:///doc.lec",
      text,
      { line, character: char } as any,
      undefined,
      buildTestBundle(text)
    )
    const arr = Array.isArray(items) ? items : (items?.items ?? [])
    const labels = new Set(arr.map((x: any) => x.label))
    expect(labels.has("exec")).toBeTrue()
    expect(labels.has("sqlite")).toBeTrue()
  })

  test("suggests interlocutor properties inside single interlocutor mapping", async () => {
    const text = `---\ninterlocutor:\n  name: A\n  prompt: hi\n  \n---\n`
    const lines = text.split(/\r?\n/)
    const line = lines.findIndex(l => l.trim() === '')
    const char = lines[line].length
    const items: any = await computeCompletions(
      "file:///doc.lec",
      text,
      { line, character: char } as any,
      undefined,
      buildTestBundle(text)
    )
    const arr = Array.isArray(items) ? items : (items?.items ?? [])
    const labels = new Set(arr.map((x: any) => x.label))
    const props = Array.from(labels)
      .map(l => String(l))
      .filter(l => (INTERLOCUTOR_KEYS as readonly string[]).includes(l))
    expect(props.length).toBeGreaterThan(0)
  })

  test("filters interlocutor property suggestions by typed prefix", async () => {
    const text = `---\ninterlocutor:\n  name: A\n  prompt: hi\n  mo\n---\n`
    const lines = text.split(/\r?\n/)
    const line = lines.findIndex(l => l.trim().startsWith('mo'))
    const char = lines[line].length
    const items: any = await computeCompletions(
      "file:///doc.lec",
      text,
      { line, character: char } as any,
      undefined,
      buildTestBundle(text)
    )
    const arr = Array.isArray(items) ? items : (items?.items ?? [])
    const labels = new Set(arr.map((x: any) => x.label))
    const props = Array.from(labels)
      .map(l => String(l))
      .filter(l => (INTERLOCUTOR_KEYS as readonly string[]).includes(l))
    expect(props.length).toBeGreaterThan(0)
    const prefixesOk = props.every(l => l.startsWith('mo'))
    expect(prefixesOk).toBeTrue()
  })

  test("suggests interlocutor properties inside interlocutors list entries", async () => {
    const text = `---\ninterlocutors:\n  - name: A\n    prompt: hi\n    \n---\n`
    const lines = text.split(/\r?\n/)
    const line = lines.findIndex(l => l.trim() === '')
    const char = lines[line].length
    const items: any = await computeCompletions(
      "file:///doc.lec",
      text,
      { line, character: char } as any,
      undefined,
      buildTestBundle(text)
    )
    const arr = Array.isArray(items) ? items : (items?.items ?? [])
    const labels = new Set(arr.map((x: any) => x.label))
    const props = Array.from(labels)
      .map(l => String(l))
      .filter(l => (INTERLOCUTOR_KEYS as readonly string[]).includes(l))
    expect(props.length).toBeGreaterThan(0)
  })

  test("tools array tool kinds filter by typed prefix", async () => {
    const text = `---\ninterlocutor:\n  name: A\n  prompt: hi\n  tools:\n    -  m\n---\n`
    const line = 5
    const char = text.split(/\r?\n/)[line].length
    const items: any = await computeCompletions(
      "file:///doc.lec",
      text,
      { line, character: char } as any,
      undefined,
      buildTestBundle(text)
    )
    const arr = Array.isArray(items) ? items : (items?.items ?? [])
    const labels = new Set(arr.map((x: any) => x.label))
    expect(labels.has("mcp_ws")).toBeTrue()
    expect(labels.has("mcp_sse")).toBeTrue()
    expect(labels.has("exec")).toBeFalse()
  })

  test("kit tool suggests kit names", async () => {
    const text = `---\nkits:\n  - name: typescript_tools\n    tools: []\ninterlocutor:\n  name: A\n  prompt: hi\n  tools:\n    - kit: \n---\n`
    const line = 8
    const char = text.split(/\r?\n/)[line].length
    const items: any = await computeCompletions(
      "file:///doc.lec",
      text,
      { line, character: char } as any,
      undefined,
      buildTestBundle(text)
    )
    const arr = Array.isArray(items) ? items : (items?.items ?? [])
    const labels = new Set(arr.map((x: any) => x.label))
    expect(labels.has("typescript_tools")).toBeTrue()
  })

  test("kit completion includes kit description", async () => {
    const text = `---\nkits:\n  - name: typescript_tools\n    description: TS tooling\n    tools: []\ninterlocutor:\n  name: A\n  prompt: hi\n  tools:\n    - kit: \n---\n`
    const line = 9
    const char = text.split(/\r?\n/)[line].length
    const items: any = await computeCompletions(
      "file:///doc.lec",
      text,
      { line, character: char } as any,
      undefined,
      buildTestBundle(text)
    )

    const arr = Array.isArray(items) ? items : (items?.items ?? [])
    const kit = arr.find((x: any) => x.label === "typescript_tools")
    expect(Boolean(kit)).toBeTrue()
    expect(String(kit.detail)).toContain("TS tooling")

    const doc = kit.documentation
    expect(doc.kind).toBe("markdown")
    expect(String(doc.value)).toContain("TS tooling")

    expect(String(kit.labelDetails.description)).toContain("TS tooling")
  })

  test("kit completion includes tools summary", async () => {
    const text = `---\nkits:\n  - name: typescript_tools\n    description: TS tooling\n    tools:\n      - exec: tsc --noEmit\n        name: typecheck\ninterlocutor:\n  name: A\n  prompt: hi\n  tools:\n    - kit: \n---\n`
    const line = 11
    const char = text.split(/\r?\n/)[line].length
    const items: any = await computeCompletions(
      "file:///doc.lec",
      text,
      { line, character: char } as any,
      undefined,
      buildTestBundle(text)
    )

    const arr = Array.isArray(items) ? items : (items?.items ?? [])
    const kit = arr.find((x: any) => x.label === "typescript_tools")
    expect(Boolean(kit)).toBeTrue()

    const doc = kit.documentation
    expect(String(doc.value)).toContain("Tools")
    expect(String(doc.value)).toContain("typecheck")
  })

  test("kit tool suggests workspace kit names (merged)", async () => {
    const text = `---\ninterlocutor:\n  name: A\n  prompt: hi\n  tools:\n    - kit: \n---\n`
    const lines = text.split(/\r?\n/)
    const line = lines.findIndex(l => l.includes('kit:'))
    const char = lines[line].length
    const wsDir = await mkdtemp(join(tmpdir(), 'lectic-ws-'))
    try {
      await writeFile(join(wsDir, 'lectic.yaml'), `kits:\n  - name: shared_kit\n    tools: []\n`)
      const items: any = await computeCompletions(
        "file:///doc.lec",
        text,
        { line, character: char } as any,
        wsDir,
        buildTestBundle(text)
      )
      const arr = Array.isArray(items) ? items : (items?.items ?? [])
      const labels = new Set(arr.map((x: any) => x.label))
      expect(labels.has("shared_kit")).toBeTrue()
    } finally {
      await rm(wsDir, { recursive: true, force: true })
    }
  })

  test("agent tool suggests interlocutor names", async () => {
    const text = `---\ninterlocutors:\n  - name: Boggle\n    prompt: hi\n  - name: Oggle\n    prompt: hi\ninterlocutor:\n  name: Main\n  prompt: hi\n  tools:\n    - agent: \n---\n`
    const lines = text.split(/\r?\n/)
    const line = lines.findIndex(l => l.includes('agent:'))
    const char = lines[line].length
    const items: any = await computeCompletions(
      "file:///doc.lec",
      text,
      { line, character: char } as any,
      undefined,
      buildTestBundle(text)
    )
    const arr = Array.isArray(items) ? items : (items?.items ?? [])
    const labels = new Set(arr.map((x: any) => x.label))
    expect(labels.has("Boggle")).toBeTrue()
    expect(labels.has("Oggle")).toBeTrue()
    expect(labels.has("Main")).toBeTrue()
  })

  test("interlocutor.name suggests known interlocutors from config", async () => {
    const text = `---\ninterlocutor:\n  name: \n---\n`
    const lines = text.split(/\r?\n/)
    const line = lines.findIndex(l => l.includes('name:'))
    const char = lines[line].length

    const wsDir = await mkdtemp(join(tmpdir(), 'lectic-ws-'))
    try {
      await writeFile(
        join(wsDir, 'lectic.yaml'),
        `interlocutors:\n  - name: opus\n    prompt: hi\n  - name: haiku\n    prompt: hi\n`
      )

      const items: any = await computeCompletions(
        "file:///doc.lec",
        text,
        { line, character: char } as any,
        wsDir,
        buildTestBundle(text)
      )
      const arr = Array.isArray(items) ? items : (items?.items ?? [])
      const labels = new Set(arr.map((x: any) => x.label))
      expect(labels.has("opus")).toBeTrue()
      expect(labels.has("haiku")).toBeTrue()
    } finally {
      await rm(wsDir, { recursive: true, force: true })
    }
  })

  test("interlocutor.name suggestions filter by typed prefix", async () => {
    const text = `---\ninterlocutor:\n  name: h\n---\n`
    const lines = text.split(/\r?\n/)
    const line = lines.findIndex(l => l.includes('name:'))
    const char = lines[line].length

    const wsDir = await mkdtemp(join(tmpdir(), 'lectic-ws-'))
    try {
      await writeFile(
        join(wsDir, 'lectic.yaml'),
        `interlocutors:\n  - name: opus\n    prompt: hi\n  - name: haiku\n    prompt: hi\n`
      )

      const items: any = await computeCompletions(
        "file:///doc.lec",
        text,
        { line, character: char } as any,
        wsDir,
        buildTestBundle(text)
      )
      const arr = Array.isArray(items) ? items : (items?.items ?? [])
      const labels = new Set(arr.map((x: any) => x.label))
      expect(labels.has("haiku")).toBeTrue()
      expect(labels.has("opus")).toBeFalse()
    } finally {
      await rm(wsDir, { recursive: true, force: true })
    }
  })

  test("native tool suggests supported types", async () => {
    const text = `---\ninterlocutor:\n  name: A\n  prompt: hi\n  tools:\n    - native: \n---\n`
    const lines = text.split(/\r?\n/)
    const line = lines.findIndex(l => l.includes('native:'))
    const char = lines[line].length
    const items: any = await computeCompletions(
      "file:///doc.lec",
      text,
      { line, character: char } as any,
      undefined,
      buildTestBundle(text)
    )
    const arr = Array.isArray(items) ? items : (items?.items ?? [])
    const labels = new Set(arr.map((x: any) => x.label))
    expect(labels.has("search")).toBeTrue()
    expect(labels.has("code")).toBeTrue()
  })

  test("does not suggest macro names inside legacy :macro[...]", async () => {
    const text = `---\nmacros:\n  - name: summarize\n    expansion: exec:echo hi\n  - name: plan\n    expansion: file:./p\n---\n:macro[su]`
    const line = text.split(/\r?\n/).length - 1
    const char = text.split(/\r?\n/)[line].length - 1
    const items: any = await computeCompletions(
      "file:///doc.lec",
      text,
      { line, character: char } as any,
      undefined,
      buildTestBundle(text)
    )
    const arr = Array.isArray(items) ? items : (items?.items ?? [])
    const labels = new Set(arr.map((x: any) => x.label))
    expect(labels.has("summarize")).toBeFalse()
    expect(labels.has("plan")).toBeFalse()
  })

  test("after ':' suggests macros as directives (new form)", async () => {
    const text = `---\nmacros:\n  - name: summarize\n    description: Summarize the conversation.\n    expansion: exec:echo hi\n---\n:su`
    const lines = text.split(/\r?\n/)
    const line = lines.length - 1
    const char = lines[line].length

    const items: any = await computeCompletions(
      "file:///doc.lec",
      text,
      { line, character: char } as any,
      undefined,
      buildTestBundle(text)
    )

    const arr = Array.isArray(items) ? items : (items?.items ?? [])
    const summarize = arr.find((x: any) => x.label === "summarize")
    expect(Boolean(summarize)).toBeTrue()
    expect(summarize.insertTextFormat).toBe(InsertTextFormat.Snippet)
    expect(summarize.textEdit.newText).toBe(":summarize[]$0")

    expect(summarize.detail).toContain("Summarize the conversation")
    expect(summarize.labelDetails.description)
      .toContain("Summarize the conversation")
  })

  test("inside :ask[...] suggests interlocutor names only", async () => {
    const text = `---\ninterlocutors:\n  - name: Boggle\n    prompt: hi\n  - name: Oggle\n    prompt: hi\n---\n:ask[Bo]`
    const line = text.split(/\r?\n/).length - 1
    const char = text.split(/\r?\n/)[line].length - 1
    const items: any = await computeCompletions(
      "file:///doc.lec",
      text,
      { line, character: char } as any,
      undefined,
      buildTestBundle(text)
    )
    const arr = Array.isArray(items) ? items : (items?.items ?? [])
    const labels = new Set(arr.map((x: any) => x.label))
    expect(labels.has("Boggle")).toBeTrue()
    expect(labels.has("Oggle")).toBeFalse()
  })

  test("does not suggest macro names inside legacy :macro[]", async () => {
    const text = `---\nmacros:\n  - name: summarize\n    expansion: exec:echo hi\n  - name: plan\n    expansion: file:./p\n---\n:macro[]`
    const lines = text.split(/\r?\n/)
    const line = lines.length - 1
    const colOpen = lines[line].indexOf(":macro[") + ":macro[".length
    const items: any = await computeCompletions(
      "file:///doc.lec",
      text,
      { line, character: colOpen } as any,
      undefined,
      buildTestBundle(text)
    )
    const arr = Array.isArray(items) ? items : (items?.items ?? [])
    const labels = new Set(arr.map((x: any) => x.label))
    expect(labels.has("summarize")).toBeFalse()
    expect(labels.has("plan")).toBeFalse()
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
      undefined,
      buildTestBundle(text)
    )
    const arr = Array.isArray(items) ? items : (items?.items ?? [])
    const labels = new Set(arr.map((x: any) => x.label))
    expect(labels.has("Boggle")).toBeTrue()
    expect(labels.has("Oggle")).toBeTrue()
  })

  test("suggests provider values", async () => {
    const text = `---\ninterlocutor:\n  name: A\n  prompt: hi\n  provider: \n---\n`
    const lines = text.split(/\r?\n/)
    const line = lines.findIndex(l => l.includes('provider:'))
    const char = lines[line].length
    const items: any = await computeCompletions(
      "file:///doc.lec",
      text,
      { line, character: char } as any,
      undefined,
      buildTestBundle(text)
    )
    const arr = Array.isArray(items) ? items : (items?.items ?? [])
    const labels = new Set(arr.map((x: any) => x.label))
    
    for (const p of Object.values(LLMProvider)) {
        expect(labels.has(p)).toBeTrue()
    }
  })

  test("suggests thinking_effort values", async () => {
    const text = `---\ninterlocutor:\n  name: A\n  prompt: hi\n  thinking_effort: \n---\n`
    const lines = text.split(/\r?\n/)
    const line = lines.findIndex(l => l.includes('thinking_effort:'))
    const char = lines[line].length
    const items: any = await computeCompletions(
      "file:///doc.lec",
      text,
      { line, character: char } as any,
      undefined,
      buildTestBundle(text)
    )
    const arr = Array.isArray(items) ? items : (items?.items ?? [])
    const labels = new Set(arr.map((x: any) => x.label))
    
    expect(labels.has("none")).toBeTrue()
    expect(labels.has("low")).toBeTrue()
    expect(labels.has("medium")).toBeTrue()
    expect(labels.has("high")).toBeTrue()
  })

  test("suggests provider values with prefix", async () => {
    const text = `---\ninterlocutor:\n  name: A\n  prompt: hi\n  provider: ant\n---\n`
    const lines = text.split(/\r?\n/)
    const line = lines.findIndex(l => l.includes('provider:'))
    const char = lines[line].length
    const items: any = await computeCompletions(
      "file:///doc.lec",
      text,
      { line, character: char } as any,
      undefined,
      buildTestBundle(text)
    )
    const arr = Array.isArray(items) ? items : (items?.items ?? [])
    const labels = new Set(arr.map((x: any) => x.label))
    
    expect(labels.has(LLMProvider.Anthropic)).toBeTrue()
    expect(labels.has(LLMProvider.AnthropicBedrock)).toBeTrue()
    expect(labels.has(LLMProvider.OpenAI)).toBeFalse()
  })
})
