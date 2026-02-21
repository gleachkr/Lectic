import { describe, test, expect } from "bun:test"
import { computeCompletions } from "./completions"
import { buildTestBundle } from "./utils/testHelpers"
import { INTERLOCUTOR_KEYS } from "./interlocutorFields"
import { LLMProvider } from "../types/provider"
import {
  CompletionTriggerKind,
  InsertTextFormat,
} from "vscode-languageserver/node"
import { mkdir, mkdtemp, rm, writeFile } from "fs/promises"
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
    expect(hasLabel(arr, "env")).toBeTrue()
    expect(hasLabel(arr, "fetch")).toBeTrue()
    expect(hasLabel(arr, "verbatim")).toBeTrue()
    expect(hasLabel(arr, "once")).toBeTrue()
    expect(hasLabel(arr, "discard")).toBeTrue()
    expect(hasLabel(arr, "attach")).toBeTrue()
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

  test("sandbox use refs suggest sandbox_defs names", async () => {
    const text = [
      "---",
      "sandbox_defs:",
      "  - name: safe",
      "    sandbox: bwrap",
      "interlocutor:",
      "  name: A",
      "  prompt: hi",
      "  sandbox:",
      "    use: ",
      "---",
      "",
    ].join("\n")

    const lines = text.split(/\r?\n/)
    const line = lines.findIndex(l => l.includes("use:"))
    const char = lines[line].length

    const items: any = await computeCompletions(
      "file:///doc.lec",
      text,
      { line, character: char } as any,
      undefined,
      buildTestBundle(text),
    )

    const arr = Array.isArray(items) ? items : (items?.items ?? [])
    expect(hasLabel(arr, "safe")).toBeTrue()
  })

  test("hook use refs suggest hook_defs names", async () => {
    const text = [
      "---",
      "hook_defs:",
      "  - name: audit",
      "    on: assistant_message",
      "    do: echo audit",
      "interlocutor:",
      "  name: A",
      "  prompt: hi",
      "  hooks:",
      "    - use: au",
      "---",
      "",
    ].join("\n")

    const lines = text.split(/\r?\n/)
    const line = lines.findIndex(l => l.includes("use: au"))
    const char = lines[line].length

    const items: any = await computeCompletions(
      "file:///doc.lec",
      text,
      { line, character: char } as any,
      undefined,
      buildTestBundle(text),
    )

    const arr = Array.isArray(items) ? items : (items?.items ?? [])
    expect(hasLabel(arr, "audit")).toBeTrue()
  })

  test("env use refs include workspace env_defs names", async () => {
    const wsDir = await mkdtemp(join(tmpdir(), "lectic-use-defs-"))
    try {
      await writeFile(
        join(wsDir, "lectic.yaml"),
        [
          "env_defs:",
          "  - name: shared_env",
          "    env:",
          "      MODE: strict",
          "",
        ].join("\n"),
      )

      const text = [
        "---",
        "interlocutor:",
        "  name: A",
        "  prompt: hi",
        "  tools:",
        "    - exec: bash",
        "      env:",
        "        use: sh",
        "---",
        "",
      ].join("\n")

      const lines = text.split(/\r?\n/)
      const line = lines.findIndex(l => l.includes("use: sh"))
      const char = lines[line].length

      const items: any = await computeCompletions(
        "file:///doc.lec",
        text,
        { line, character: char } as any,
        wsDir,
        buildTestBundle(text),
      )

      const arr = Array.isArray(items) ? items : (items?.items ?? [])
      expect(hasLabel(arr, "shared_env")).toBeTrue()
    } finally {
      await rm(wsDir, { recursive: true, force: true })
    }
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

  test("macro directive completion places cursor inside brackets when macro has completions", async () => {
    const text = [
      "---",
      "macros:",
      "  - name: deploy",
      "    expansion: x",
      "    completions:",
      "      - completion: prod",
      "---",
      ":de",
    ].join("\n")

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
    const deploy = arr.find((x: any) => x.label === "deploy")
    expect(Boolean(deploy)).toBeTrue()
    expect(deploy.insertTextFormat).toBe(InsertTextFormat.Snippet)
    expect(deploy.textEdit.newText).toBe(":deploy[$0]")
    expect(deploy.command?.command).toBe("editor.action.triggerSuggest")
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

  test("inside :macro[...] suggests inline macro argument completions", async () => {
    const text = [
      "---",
      "macros:",
      "  - name: deploy",
      "    expansion: x",
      "    completions:",
      "      - completion: prod",
      "        detail: Deploy to production",
      "      - completion: staging",
      "        detail: Deploy to staging",
      "---",
      ":deploy[]",
    ].join("\n")

    const lines = text.split(/\r?\n/)
    const line = lines.length - 1
    const char = lines[line].indexOf(":deploy[") + ":deploy[".length

    const items: any = await computeCompletions(
      "file:///doc.lec",
      text,
      { line, character: char } as any,
      undefined,
      buildTestBundle(text),
    )

    const arr = Array.isArray(items) ? items : (items?.items ?? [])
    const labels = new Set(arr.map((x: any) => x.label))

    expect(labels.has("prod")).toBeTrue()
    expect(labels.has("staging")).toBeTrue()

    const prod = arr.find((x: any) => x.label === "prod")
    expect(String(prod.detail)).toContain("Deploy to production")
    expect(prod.documentation).toBeUndefined()
  })

  test("macro argument completion supports detail and documentation", async () => {
    const text = [
      "---",
      "macros:",
      "  - name: deploy",
      "    expansion: x",
      "    completions:",
      "      - completion: prod",
      "        detail: Deploy to production",
      "        documentation: Full docs",
      "---",
      ":deploy[p]",
    ].join("\n")

    const lines = text.split(/\r?\n/)
    const line = lines.length - 1
    const closeChar = lines[line].indexOf("]")

    const items: any = await computeCompletions(
      "file:///doc.lec",
      text,
      { line, character: closeChar } as any,
      undefined,
      buildTestBundle(text),
    )

    const arr = Array.isArray(items) ? items : (items?.items ?? [])
    const prod = arr.find((x: any) => x.label === "prod")
    expect(String(prod.detail)).toBe("Deploy to production")
    expect(String(prod.documentation)).toBe("Full docs")
  })

  test("macro argument completions filter by prefix and replace bracket range", async () => {
    const text = [
      "---",
      "macros:",
      "  - name: deploy",
      "    expansion: x",
      "    completions:",
      "      - completion: prod",
      "      - completion: staging",
      "---",
      ":deploy[st]",
    ].join("\n")

    const lines = text.split(/\r?\n/)
    const line = lines.length - 1
    const closeChar = lines[line].indexOf("]")

    const items: any = await computeCompletions(
      "file:///doc.lec",
      text,
      { line, character: closeChar } as any,
      undefined,
      buildTestBundle(text),
    )

    const arr = Array.isArray(items) ? items : (items?.items ?? [])
    expect(arr.length).toBe(1)
    expect(arr[0].label).toBe("staging")

    const textEdit = arr[0].textEdit
    expect(textEdit.range.start.character)
      .toBe(lines[line].indexOf(":deploy[") + ":deploy[".length)
    expect(textEdit.range.end.character).toBe(closeChar)
  })

  test("macro argument completions de-duplicate by completion", async () => {
    const text = [
      "---",
      "macros:",
      "  - name: deploy",
      "    expansion: x",
      "    completions:",
      "      - completion: prod",
      "        detail: First",
      "      - completion: prod",
      "        detail: Second",
      "---",
      ":deploy[p]",
    ].join("\n")

    const lines = text.split(/\r?\n/)
    const line = lines.length - 1
    const closeChar = lines[line].indexOf("]")

    const items: any = await computeCompletions(
      "file:///doc.lec",
      text,
      { line, character: closeChar } as any,
      undefined,
      buildTestBundle(text),
    )

    const arr = Array.isArray(items) ? items : (items?.items ?? [])
    const prodItems = arr.filter((x: any) => x.label === "prod")
    expect(prodItems.length).toBe(1)
    expect(String(prodItems[0].detail)).toContain("First")
  })

  test("macro argument completions load from file source", async () => {
    const wsDir = await mkdtemp(join(tmpdir(), 'lectic-macro-comps-file-'))
    try {
      await writeFile(
        join(wsDir, 'deploy-completions.yaml'),
        `- completion: prod
  detail: Deploy to production
`
      )

      const text = [
        "---",
        "macros:",
        "  - name: deploy",
        "    expansion: x",
        `    completions: file:${join(wsDir, 'deploy-completions.yaml')}`,
        "---",
        ":deploy[p]",
      ].join("\n")

      const lines = text.split(/\r?\n/)
      const line = lines.length - 1
      const closeChar = lines[line].indexOf("]")

      const items: any = await computeCompletions(
        "file:///doc.lec",
        text,
        { line, character: closeChar } as any,
        wsDir,
        buildTestBundle(text),
      )

      const arr = Array.isArray(items) ? items : (items?.items ?? [])
      const labels = new Set(arr.map((x: any) => x.label))
      expect(labels.has("prod")).toBeTrue()
    } finally {
      await rm(wsDir, { recursive: true, force: true })
    }
  })

  test("macro argument completions accept JSON array source", async () => {
    const wsDir = await mkdtemp(join(tmpdir(), 'lectic-macro-comps-json-'))
    try {
      await writeFile(
        join(wsDir, 'deploy-completions.json'),
        "[{\"completion\":\"prod\",\"detail\":\"Deploy\"}]"
      )

      const text = [
        "---",
        "macros:",
        "  - name: deploy",
        "    expansion: x",
        `    completions: file:${join(wsDir, 'deploy-completions.json')}`,
        "---",
        ":deploy[p]",
      ].join("\n")

      const lines = text.split(/\r?\n/)
      const line = lines.length - 1
      const closeChar = lines[line].indexOf("]")

      const items: any = await computeCompletions(
        "file:///doc.lec",
        text,
        { line, character: closeChar } as any,
        wsDir,
        buildTestBundle(text),
      )

      const arr = Array.isArray(items) ? items : (items?.items ?? [])
      expect(hasLabel(arr, "prod")).toBeTrue()
    } finally {
      await rm(wsDir, { recursive: true, force: true })
    }
  })

  test("macro argument completions resolve file:local paths", async () => {
    const wsDir = await mkdtemp(join(tmpdir(), 'lectic-macro-comps-local-'))
    try {
      const compDir = join(wsDir, 'completions')
      await mkdir(compDir, { recursive: true })
      await writeFile(
        join(compDir, 'deploy.yaml'),
        `- completion: staging
  detail: Deploy to staging
`
      )

      const text = [
        "---",
        "macros:",
        "  - name: deploy",
        "    expansion: x",
        "    completions: file:local:./completions/deploy.yaml",
        "---",
        ":deploy[s]",
      ].join("\n")

      const lines = text.split(/\r?\n/)
      const line = lines.length - 1
      const closeChar = lines[line].indexOf("]")

      const items: any = await computeCompletions(
        "file:///doc.lec",
        text,
        { line, character: closeChar } as any,
        wsDir,
        buildTestBundle(text),
      )

      const arr = Array.isArray(items) ? items : (items?.items ?? [])
      const labels = new Set(arr.map((x: any) => x.label))
      expect(labels.has("staging")).toBeTrue()
    } finally {
      await rm(wsDir, { recursive: true, force: true })
    }
  })

  test("exec macro argument completions load YAML output", async () => {
    const text = [
      "---",
      "macros:",
      "  - name: deploy",
      "    expansion: x",
      "    completions: >",
      "      exec:sh -c 'printf \"%s\\\\n\" \"- completion: prod\"'",
      "---",
      ":deploy[p]",
    ].join("\n")

    const lines = text.split(/\r?\n/)
    const line = lines.length - 1
    const closeChar = lines[line].indexOf("]")

    const items: any = await computeCompletions(
      "file:///doc.lec",
      text,
      { line, character: closeChar } as any,
      undefined,
      buildTestBundle(text),
      { triggerKind: CompletionTriggerKind.Invoked } as any,
    )

    const arr = Array.isArray(items) ? items : (items?.items ?? [])
    const labels = new Set(arr.map((x: any) => x.label))
    expect(labels.has("prod")).toBeTrue()
  })

  test("exec macro completions inherit macro env and dynamic vars", async () => {
    const text = [
      "---",
      "macros:",
      "  - name: deploy",
      "    expansion: x",
      "    env:",
      "      DEFAULT_REGION: us-west-2",
      "    completions: >",
      "      exec:sh -c 'printf \"%s\\\\n\" \"- completion: ${ARG_PREFIX}-${DEFAULT_REGION}-${MACRO_NAME}-${LECTIC_COMPLETION}\"'",
      "---",
      ":deploy[st]",
    ].join("\n")

    const lines = text.split(/\r?\n/)
    const line = lines.length - 1
    const closeChar = lines[line].indexOf("]")

    const items: any = await computeCompletions(
      "file:///doc.lec",
      text,
      { line, character: closeChar } as any,
      undefined,
      buildTestBundle(text),
      { triggerKind: CompletionTriggerKind.Invoked } as any,
    )

    const arr = Array.isArray(items) ? items : (items?.items ?? [])
    const labels = new Set(arr.map((x: any) => x.label))
    expect(labels.has("st-us-west-2-deploy-1")).toBeTrue()
  })

  test("exec macro completions default to manual trigger policy", async () => {
    const text = [
      "---",
      "macros:",
      "  - name: deploy",
      "    expansion: x",
      "    completions: >",
      "      exec:sh -c 'printf \"%s\\\\n\" \"- completion: prod\"'",
      "---",
      ":deploy[p]",
    ].join("\n")

    const lines = text.split(/\r?\n/)
    const line = lines.length - 1
    const closeChar = lines[line].indexOf("]")

    const autoItems: any = await computeCompletions(
      "file:///doc.lec",
      text,
      { line, character: closeChar } as any,
      undefined,
      buildTestBundle(text),
      {
        triggerKind: CompletionTriggerKind.TriggerCharacter,
        triggerCharacter: "[",
      } as any,
    )
    const autoArr = Array.isArray(autoItems)
      ? autoItems
      : (autoItems?.items ?? [])
    expect(autoArr.length).toBe(0)

    const manualItems: any = await computeCompletions(
      "file:///doc.lec",
      text,
      { line, character: closeChar } as any,
      undefined,
      buildTestBundle(text),
      { triggerKind: CompletionTriggerKind.Invoked } as any,
    )
    const manualArr = Array.isArray(manualItems)
      ? manualItems
      : (manualItems?.items ?? [])
    expect(hasLabel(manualArr, "prod")).toBeTrue()
  })

  test("completion_trigger: auto overrides exec manual default", async () => {
    const text = [
      "---",
      "macros:",
      "  - name: deploy",
      "    expansion: x",
      "    completions: >",
      "      exec:sh -c 'printf \"%s\\\\n\" \"- completion: prod\"'",
      "    completion_trigger: auto",
      "---",
      ":deploy[p]",
    ].join("\n")

    const lines = text.split(/\r?\n/)
    const line = lines.length - 1
    const closeChar = lines[line].indexOf("]")

    const autoItems: any = await computeCompletions(
      "file:///doc.lec",
      text,
      { line, character: closeChar } as any,
      undefined,
      buildTestBundle(text),
      {
        triggerKind: CompletionTriggerKind.TriggerCharacter,
        triggerCharacter: "[",
      } as any,
    )

    const autoArr = Array.isArray(autoItems)
      ? autoItems
      : (autoItems?.items ?? [])
    expect(hasLabel(autoArr, "prod")).toBeTrue()
  })

  test("invalid macro completion source output fails soft", async () => {
    const text = [
      "---",
      "macros:",
      "  - name: deploy",
      "    expansion: x",
      "    completions: exec:echo not-a-list",
      "---",
      ":deploy[n]",
    ].join("\n")

    const lines = text.split(/\r?\n/)
    const line = lines.length - 1
    const closeChar = lines[line].indexOf("]")

    const items: any = await computeCompletions(
      "file:///doc.lec",
      text,
      { line, character: closeChar } as any,
      undefined,
      buildTestBundle(text),
      { triggerKind: CompletionTriggerKind.Invoked } as any,
    )

    const arr = Array.isArray(items) ? items : (items?.items ?? [])
    expect(arr.length).toBe(0)
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
