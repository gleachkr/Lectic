import type { CompletionItem, CompletionParams, TextEdit } from "vscode-languageserver"
import { CompletionItemKind, InsertTextFormat, Range as RangeNS } from "vscode-languageserver/node"
import { buildMacroIndex, previewMacro } from "./macroIndex"
import { buildInterlocutorIndex, previewInterlocutor } from "./interlocutorIndex"
import { directiveAtPosition, findSingleColonStart, computeReplaceRange } from "./directives"
import { isLecticHeaderSpec } from "../types/lectic"
import { mergedHeaderSpecForDoc } from "../parsing/parse"

export async function computeCompletions(
  _uri: string,
  docText: string,
  pos: CompletionParams["position"],
  docDir: string | undefined
): Promise<CompletionItem[] | null> {
  const lineText = docText.split(/\r?\n/)[pos.line] ?? ""
  const colonStart = findSingleColonStart(lineText, pos.character)

  const items: CompletionItem[] = []

  // 1) Inside :ask[...]/:aside[...]/:macro[...]
  const dctx = directiveAtPosition(docText, pos)
  if (dctx && dctx.insideBrackets && (dctx.key === "ask" || dctx.key === "aside" || dctx.key === "macro")) {
    const spec = await mergedHeaderSpecForDoc(docText, docDir)
    if (!isLecticHeaderSpec(spec)) return items

    const innerText = dctx.innerPrefix.toLowerCase()

    if (dctx.key === "ask" || dctx.key === "aside") {
      const interNames = buildInterlocutorIndex(spec)
      for (const n of interNames) {
        if (!n.name.toLowerCase().startsWith(innerText)) continue
        const textEdit: TextEdit = {
          range: RangeNS.create(dctx.innerStart, pos),
          newText: n.name
        }
        items.push({
          label: n.name,
          kind: CompletionItemKind.Value,
          detail: previewInterlocutor(n).detail,
          documentation: previewInterlocutor(n).documentation,
          insertTextFormat: InsertTextFormat.PlainText,
          textEdit
        })
      }
      return items
    }

    if (dctx.key === "macro") {
      const macros = buildMacroIndex(spec)
      for (const m of macros) {
        if (!m.name.toLowerCase().startsWith(innerText)) continue
        const textEdit: TextEdit = {
          range: RangeNS.create(dctx.innerStart, pos),
          newText: m.name
        }
        items.push({
          label: m.name,
          kind: CompletionItemKind.Variable,
          detail: previewMacro(m).detail,
          documentation: previewMacro(m).documentation,
          insertTextFormat: InsertTextFormat.PlainText,
          textEdit
        })
      }
      return items
    }
  }

  // 2) Directive keywords on ':'
  if (colonStart === null) return null

  type Dir = { key: string, label: string, insert: string, detail: string, documentation: string }
  const directives: Dir[] = [
    { key: "cmd", label: "cmd", insert: ":cmd[${0:command}]",
      detail: ":cmd — run a shell command and insert stdout",
      documentation: "Execute a shell command using the Bun shell and inline its stdout into the message." },
    { key: "reset", label: "reset", insert: ":reset[]$0",
      detail: ":reset — clear prior conversation context for this turn",
      documentation: "Reset the context window so this turn starts fresh." },
    { key: "ask", label: "ask", insert: ":ask[$0]",
      detail: ":ask — switch interlocutor for subsequent turns",
      documentation: "Switch the active interlocutor permanently." },
    { key: "aside", label: "aside", insert: ":aside[$0]",
      detail: ":aside — address one interlocutor for a single turn",
      documentation: "Temporarily switch interlocutor for this turn only." },
    { key: "macro", label: "macro", insert: ":macro[$0]",
      detail: ":macro — expand a named macro",
      documentation: "Insert a macro expansion by name." },
  ]

  const prefix = lineText.slice(colonStart + 1, pos.character).toLowerCase()
  for (const d of directives) {
    if (!d.key.startsWith(prefix)) continue
    const textEdit: TextEdit = {
      range: computeReplaceRange(pos.line, colonStart, pos.character),
      newText: d.insert
    }
    const triggerSuggest = (d.key === "ask" || d.key === "aside" || d.key === "macro")
      ? { title: "trigger suggest", command: "editor.action.triggerSuggest" }
      : undefined
    items.push({
      label: d.label,
      kind: CompletionItemKind.Snippet,
      detail: d.detail,
      documentation: d.documentation,
      insertTextFormat: InsertTextFormat.Snippet,
      textEdit,
      command: triggerSuggest as any
    })
  }

  return items
}

