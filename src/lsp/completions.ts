import type { CompletionItem, CompletionParams, TextEdit } from "vscode-languageserver"
import { CompletionItemKind, InsertTextFormat, Range as RangeNS } from "vscode-languageserver/node"
import { buildMacroIndex, previewMacro } from "./macroIndex"
import { buildInterlocutorIndex, previewInterlocutor } from "./interlocutorIndex"
import { directiveAtPositionFromBundle, findSingleColonStart, computeReplaceRange } from "./directives"
import { isLecticHeaderSpec } from "../types/lectic"
import { mergedHeaderSpecForDocDetailed, getYaml } from "../parsing/parse"
import type { AnalysisBundle } from "./analysisTypes"
import { buildHeaderRangeIndex } from "./yamlRanges"
import { parseYaml, getValue, stringOf } from "./utils/yamlAst"
import { getDefaultProvider, isLLMProvider, LLMProvider } from "../types/provider"
import { modelRegistry } from "./models"
import { isObjectRecord } from "../types/guards"

export async function computeCompletions(
  _uri: string,
  docText: string,
  pos: CompletionParams["position"],
  docDir: string | undefined,
  bundle?: AnalysisBundle
): Promise<CompletionItem[] | null> {
  const lineText = docText.split(/\r?\n/)[pos.line] ?? ""
  const colonStart = findSingleColonStart(lineText, pos.character)

  const items: CompletionItem[] = []

  // 0) YAML header: model suggestions for active provider
  {
    const header = buildHeaderRangeIndex(docText)
    if (header) {
      // Find a model field whose range contains the cursor
      const hit = header.fieldRanges.find(fr => {
        const last = fr.path[fr.path.length - 1]
        if (last !== 'model') return false
        const r = fr.range
        if (pos.line < r.start.line || pos.line > r.end.line) return false
        if (pos.line === r.start.line && pos.character < r.start.character) return false
        if (pos.line === r.end.line && pos.character > r.end.character) return false
        return true
      })
      if (hit) {
        // Determine provider from merged spec (respects system/workspace)
        const specRes = await mergedHeaderSpecForDocDetailed(docText, docDir)
        const spec = specRes.spec as unknown
        const root = isObjectRecord(spec) ? spec : {}
        let provider: LLMProvider | null = null
        try {
          if (hit.path[0] === 'interlocutor') {
            const it = isObjectRecord(root['interlocutor']) 
                ? root['interlocutor'] : undefined
            const p = it?.['provider']
            provider = isLLMProvider(p) ? p : getDefaultProvider()
          } else if (hit.path[0] === 'interlocutors' && typeof hit.path[1] === 'number') {
            // Match merged interlocutor by name from local header
            const yamlText = getYaml(docText) ?? ''
            const localDoc = parseYaml(yamlText).contents as unknown
            const lroot = isObjectRecord(localDoc) ? localDoc : {}
            const arr = lroot['interlocutors']
            const itLocal = Array.isArray(arr) 
                ? (arr as unknown[])[hit.path[1] as number] : undefined
            const localName = stringOf(getValue(itLocal, 'name'))
            const mergedArr = Array.isArray(root['interlocutors']) 
                ? (root['interlocutors'] as unknown[]) : []
            let fromMerged: unknown = undefined
            if (typeof localName === 'string') {
              for (const m of mergedArr) {
                if (isObjectRecord(m) && typeof m['name'] === 'string' && m['name'] === localName) {
                  fromMerged = m['provider']
                  break
                }
              }
            }
            provider = isLLMProvider(fromMerged) ? fromMerged : getDefaultProvider()
          }
        } catch {
          try { provider = getDefaultProvider() } catch { provider = null }
        }

        if (provider) {
          const models = modelRegistry.get(provider) ?? []
          for (const m of models) {
            items.push({
              label: m,
              kind: CompletionItemKind.Value,
              detail: `model (${provider})`,
              insertTextFormat: InsertTextFormat.PlainText,
            })
          }
          return items
        }
      }
    }
  }

  // 1) Inside :ask[...]/:aside[...]/:macro[...]
  const dctx = bundle ? directiveAtPositionFromBundle(docText, pos, bundle) : null
  if (dctx && dctx.insideBrackets && (dctx.key === "ask" || dctx.key === "aside" || dctx.key === "macro")) {
    const specRes = await mergedHeaderSpecForDocDetailed(docText, docDir)
    const spec = specRes.spec
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
      command: triggerSuggest
    })
  }

  return items
}

