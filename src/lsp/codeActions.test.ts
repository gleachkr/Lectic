import { describe, test, expect } from "bun:test"
import { computeCodeActions, resolveCodeAction } from "./codeActions"
import { buildTestBundle } from "./utils/testHelpers"
import { CodeActionKind } from "vscode-languageserver/node"
import { Range } from "vscode-languageserver-types"

describe("codeActions (unit)", () => {
  test("computeCodeActions suggests macro expansion", async () => {
    const text = `---
macros:
  - name: hello
    expansion: Hello World
---
:hello[]`
    const lines = text.split("\n")
    const line = lines.length - 1
    const char = 2 // Inside :hello[]
    
    const actions = await computeCodeActions(
      "file:///doc.lec",
      text,
      {
        textDocument: { uri: "file:///doc.lec" },
        range: Range.create(line, char, line, char),
        context: { diagnostics: [] }
      },
      undefined,
      buildTestBundle(text)
    )

    expect(actions).not.toBeNull()
    const expansionAction = actions?.find(
      a => a.kind === CodeActionKind.RefactorInline && a.title === "Expand macro :hello"
    )
    expect(expansionAction).toBeDefined()
    expect(expansionAction?.data).toEqual({
      type: 'expand-macro',
      uri: "file:///doc.lec",
      range: Range.create(line, 0, line, ":hello[]".length)
    })
  })

  test("resolveCodeAction expands macro", async () => {
    const text = `---
macros:
  - name: hello
    expansion: Hello World
---
:hello[]`
    const lines = text.split("\n")
    const line = lines.length - 1
    
    // Construct the action data as if computeCodeActions returned it
    const actionData = {
      type: 'expand-macro',
      uri: "file:///doc.lec",
      range: Range.create(line, 0, line, ":hello[]".length)
    }

    const action = {
      title: "Expand macro :hello",
      kind: CodeActionKind.RefactorInline,
      data: actionData
    }

    const resolved = await resolveCodeAction(action, text, undefined)

    expect(resolved.edit).toBeDefined()
    expect(resolved.edit?.changes?.["file:///doc.lec"]).toHaveLength(1)
    const edit = resolved.edit?.changes?.["file:///doc.lec"][0]
    expect(edit?.newText).toBe("Hello World")
    expect(edit?.range).toEqual(actionData.range)
  })

  test("resolveCodeAction handles recursive expansion", async () => {
    const text = `---
macros:
  - name: inner
    expansion: Inner
  - name: outer
    expansion: Outer :inner[]
---
:outer[]`
    const lines = text.split("\n")
    const line = lines.length - 1
    
    const actionData = {
      type: 'expand-macro',
      uri: "file:///doc.lec",
      range: Range.create(line, 0, line, ":outer[]".length)
    }

    const action = {
      title: "Expand macro :outer",
      kind: CodeActionKind.RefactorInline,
      data: actionData
    }

    const resolved = await resolveCodeAction(action, text, undefined)

    expect(resolved.edit).toBeDefined()
    const edit = resolved.edit?.changes?.["file:///doc.lec"][0]
    expect(edit?.newText).toBe("Outer Inner")
  })
})
