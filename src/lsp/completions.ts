import type { CompletionItem, CompletionParams, TextEdit, Position, Range } from "vscode-languageserver"
import { CompletionItemKind, InsertTextFormat, Range as RangeNS } from "vscode-languageserver/node"
import { buildMacroIndex, previewMacro } from "./macroIndex"
import { buildInterlocutorIndex, previewInterlocutor } from "./interlocutorIndex"
import { directiveAtPositionFromBundle, findSingleColonStart, computeReplaceRange } from "./directives"
import { isLecticHeaderSpec } from "../types/lectic"
import { mergedHeaderSpecForDocDetailed, getYaml } from "../parsing/parse"
import type { AnalysisBundle } from "./analysisTypes"
import { buildHeaderRangeIndex } from "./yamlRanges"
import { parseYaml, getValue, itemsOf, stringOf } from "./utils/yamlAst"
import { modelRegistry } from "./models"
import { isObjectRecord } from "../types/guards"
import { inRange } from "./utils/range"
import { startsWithCI } from "./utils/text"
import { effectiveProviderForPath } from "./utils/provider"
import { LLMProvider } from "../types/provider"
import { INTERLOCUTOR_KEYS } from "./interlocutorFields"



// Static tool kind catalog for YAML tools arrays
const TOOL_KINDS: Array<{ key: string, detail: string, sort: string }> = [
  { key: 'exec',         detail: 'Execute a command or script',           sort: '01_exec' },
  { key: 'sqlite',       detail: 'SQLite database query tool',            sort: '02_sqlite' },
  { key: 'mcp_command',  detail: 'Local MCP server tool',                 sort: '20_mcp_command' },
  { key: 'mcp_ws',       detail: 'WebSocket MCP server tool',             sort: '21_mcp_ws' },
  { key: 'mcp_sse',      detail: 'SSE MCP server tool',                   sort: '22_mcp_sse' },
  { key: 'mcp_shttp',    detail: 'Streamable HTTP MCP tool',              sort: '23_mcp_shttp' },
  { key: 'agent',        detail: 'Interlocutor-as-tool agent',            sort: '10_agent' },
  { key: 'think_about',  detail: 'Scratchpad reasoning tool',             sort: '11_think' },
  { key: 'serve_on_port',detail: 'Ephemeral HTTP server tool',            sort: '12_serve' },
  { key: 'native',       detail: 'Provider-native tool (search/code)',    sort: '13_native' },
  { key: 'kit',          detail: 'Reference a named tool kit',            sort: '14_kit' },
]

const NATIVE_SUPPORTED = ['search', 'code']

const INTERLOCUTOR_FIELD_ITEMS: Array<{ key: string, detail: string, sort: string }> =
  INTERLOCUTOR_KEYS.map((key, idx) => ({
    key,
    detail: 'Interlocutor property',
    sort: String(idx + 1).padStart(2, '0') + '_' + key,
  }))

function computeValueEdit(
  lineText: string,
  pos: Position,
): { prefixLc: string, range: Range } {
  const linePrefix = lineText.slice(0, pos.character)
  const colonIndex = linePrefix.lastIndexOf(':')
  const afterColon = colonIndex >= 0 ? linePrefix.slice(colonIndex + 1) : ''
  const prefixRaw = afterColon.replace(/^\s*/, '')
  const prefixLc = prefixRaw.toLowerCase()
  const replaceStartChar =
    colonIndex + 1 + (afterColon.length - prefixRaw.length)
  const range = RangeNS.create(
    { line: pos.line, character: replaceStartChar },
    { line: pos.line, character: pos.character },
  )
  return { prefixLc, range }
}

export async function computeCompletions(
  _uri: string,
  docText: string,
  pos: CompletionParams["position"],
  docDir: string | undefined,
  bundle?: AnalysisBundle
): Promise<CompletionItem[] | null> {
  const allLines = docText.split(/\r?\n/)
  const lineText = allLines[pos.line] ?? ""
  const colonStart = findSingleColonStart(lineText, pos.character)

  const items: CompletionItem[] = []

  // 0) YAML header completions: model, tool kinds, kit/agent/native values
  const header = buildHeaderRangeIndex(docText)
  if (header) {
    const yamlText = getYaml(docText) ?? ''
    const parsedDoc = parseYaml(yamlText)
    const yamlRoot = parsedDoc.contents as unknown
    const insideHeaderRange = inRange(pos, header.headerFullRange)

    // Model value suggestions for active provider
    const modelHit = header.fieldRanges.find(fr => {
      const last = fr.path[fr.path.length - 1]
      if (last !== 'model') return false
      return inRange(pos, fr.range)
    })
    if (modelHit) {
      const provider = await effectiveProviderForPath(
        docText,
        docDir,
        yamlRoot,
        modelHit.path,
      )

      if (provider) {
        const models = modelRegistry.get(provider) ?? []
        const { prefixLc, range } = computeValueEdit(lineText, pos)
        for (const m of models) {
          if (prefixLc && !startsWithCI(m, prefixLc)) continue
          items.push({
            label: m,
            kind: CompletionItemKind.Value,
            detail: `model (${provider})`,
            insertTextFormat: InsertTextFormat.PlainText,
            // Let client replace the typed prefix
            textEdit: prefixLc ? { range, newText: m } : undefined,
          })
        }
        return items
      }
    }

    // Provider value suggestions
    const providerHit = header.fieldRanges.find(fr => {
      const last = fr.path[fr.path.length - 1]
      return last === 'provider' && inRange(pos, fr.range)
    })
    if (providerHit) {
      const { prefixLc, range } = computeValueEdit(lineText, pos)
      const providers = Object.values(LLMProvider)
      for (const p of providers) {
        if (prefixLc && !startsWithCI(p, prefixLc)) continue
        items.push({
          label: p,
          kind: CompletionItemKind.Value,
          detail: 'Provider',
          insertTextFormat: InsertTextFormat.PlainText,
          textEdit: { range, newText: p },
        })
      }
      return items
    }

    // Thinking effort suggestions
    const thinkingEffortHit = header.fieldRanges.find(fr => {
      const last = fr.path[fr.path.length - 1]
      return last === 'thinking_effort' && inRange(pos, fr.range)
    })
    if (thinkingEffortHit) {
      const { prefixLc, range } = computeValueEdit(lineText, pos)
      const values = ["none", "low", "medium", "high"]
      for (const v of values) {
        if (prefixLc && !startsWithCI(v, prefixLc)) continue
        items.push({
          label: v,
          kind: CompletionItemKind.Value,
          detail: 'Thinking Effort',
          insertTextFormat: InsertTextFormat.PlainText,
          textEdit: { range, newText: v },
        })
      }
      return items
    }

    // Interlocutor property name suggestions inside mappings
    const linePrefix = lineText.slice(0, pos.character)
    const colonInLine = linePrefix.lastIndexOf(':')
    const trimmedLine = linePrefix.trimStart()
    const isListItemLine = trimmedLine.startsWith('-')

    if (colonInLine === -1 && !isListItemLine) {
      const interMapping = header.fieldRanges.find(fr => {
        const p = fr.path
        const isInterPath =
          (p.length === 1 && p[0] === 'interlocutor') ||
          (p.length === 2 && p[0] === 'interlocutors' && typeof p[1] === 'number')
        if (!isInterPath) return false

        if (inRange(pos, fr.range)) return true
        if (!insideHeaderRange) return false

        const afterEnd =
          pos.line > fr.range.end.line ||
          (pos.line === fr.range.end.line && pos.character > fr.range.end.character)
        if (!afterEnd) return false

        for (let l = fr.range.end.line + 1; l <= pos.line; l++) {
          const t = allLines[l] ?? ''
          const trimmed = t.trim()
          if (trimmed === '' || trimmed.startsWith('#')) continue
          return false
        }
        return true
      })

      const insideTools = header.fieldRanges.some(fr => {
        if (!inRange(pos, fr.range)) return false
        const p = fr.path
        if (p.length === 2 && p[0] === 'interlocutor' && p[1] === 'tools') return true
        if (
          p.length === 3 &&
          p[0] === 'interlocutors' &&
          typeof p[1] === 'number' &&
          p[2] === 'tools'
        ) return true
        return false
      })

      const keyMatch = /^\s*([A-Za-z_][A-Za-z0-9_]*)?\s*$/.exec(linePrefix)
      if (interMapping && !insideTools && keyMatch) {
        const indentMatch = /^(\s*)/.exec(linePrefix) ?? ['','']
        const indent = indentMatch[1] ?? ''
        const keyPrefixRaw = keyMatch[1] ?? ''
        const keyPrefixLc = keyPrefixRaw.toLowerCase()

        const getNodeAtPath = (root: unknown, path: (string | number)[]): unknown => {
          let node: unknown = root
          for (const seg of path) {
            if (typeof seg === 'string') {
              node = getValue(node, seg)
            } else {
              const items = itemsOf(node)
              node = items[seg]
            }
            if (!node) break
          }
          return node
        }

        const mapNode = getNodeAtPath(yamlRoot, interMapping.path)
        const seenKeys = new Set<string>()
        const itemNodes = itemsOf(mapNode)
        for (const it of itemNodes) {
          const keyNode = isObjectRecord(it)
            ? (it as { [k: string]: unknown })['key']
            : undefined
          const keyName = stringOf(keyNode)
          if (typeof keyName === 'string') seenKeys.add(keyName)
        }

        const replaceRange = RangeNS.create(
          { line: pos.line, character: indent.length },
          { line: pos.line, character: pos.character },
        )

        for (const f of INTERLOCUTOR_FIELD_ITEMS) {
          if (seenKeys.has(f.key)) continue
          if (keyPrefixLc && !f.key.toLowerCase().startsWith(keyPrefixLc)) continue
          items.push({
            label: f.key,
            kind: CompletionItemKind.Property,
            detail: f.detail,
            sortText: f.sort,
            insertTextFormat: InsertTextFormat.PlainText,
            textEdit: {
              range: replaceRange,
              newText: `${f.key}: `,
            },
          })
        }

        if (items.length > 0) return items
      }
    }

    // Tool kinds inside tools arrays
    const toolItem = header.toolItemRanges.find(tr => inRange(pos, tr.range))
    if (toolItem) {
      const linePrefix = lineText.slice(0, pos.character)
      const dashIndex = linePrefix.lastIndexOf('-')
      if (dashIndex >= 0) {
        const afterDash = linePrefix.slice(dashIndex + 1)
        if (!afterDash.includes(':')) {
          const prefixRaw = afterDash.replace(/^\s*/, '')
          const prefixLc = prefixRaw.toLowerCase()
          const replaceStartChar =
            dashIndex + 1 + (afterDash.length - prefixRaw.length)
          const textEditRange = RangeNS.create(
            { line: pos.line, character: replaceStartChar },
            { line: pos.line, character: pos.character },
          )

          for (const tk of TOOL_KINDS) {
            if (prefixLc && !tk.key.toLowerCase().startsWith(prefixLc)) continue
            const textEdit: TextEdit = {
              range: textEditRange,
              newText: `${tk.key}: `,
            }
            items.push({
              label: tk.key,
              kind: CompletionItemKind.Keyword,
              detail: tk.detail,
              sortText: tk.sort,
              insertTextFormat: InsertTextFormat.PlainText,
              textEdit,
            })
          }

          return items
        }
      }
    }

    // Kit name suggestions after kit:
    const inKitValue = header.kitTargetRanges.find(kr => inRange(pos, kr.range))
      || header.fieldRanges.find(fr => {
        const last = fr.path[fr.path.length - 1]
        return last === 'kit' && inRange(pos, fr.range)
      })
    // Fallback: inside a tools item and the line looks like "... kit: <cursor>"
    const linePrefix2 = lineText.slice(0, pos.character)
    const colonIdx = linePrefix2.lastIndexOf(':')
    const looksLikeKitLine = insideHeaderRange && colonIdx >= 0 && /kit\s*$/i.test(linePrefix2.slice(0, colonIdx).trimEnd())

    if (inKitValue || looksLikeKitLine) {
      const specRes = await mergedHeaderSpecForDocDetailed(docText, docDir)
      const spec = specRes.spec
      if (!isLecticHeaderSpec(spec)) return items
      const mergedKitsUnknown = (spec as Record<string, unknown>)['kits']
      const mergedKits = Array.isArray(mergedKitsUnknown) ? mergedKitsUnknown as unknown[] : []

      const edit = computeValueEdit(lineText, pos)
      const prefixLc = edit.prefixLc
      const textEditRange = edit.range

      const seen = new Set<string>()
      for (const kit of mergedKits) {
        if (!isObjectRecord(kit)) continue
        const nameRaw = kit['name']
        const name = typeof nameRaw === 'string' ? nameRaw : undefined
        if (!name) continue
        const key = name.toLowerCase()
        if (seen.has(key)) continue
        if (prefixLc && !startsWithCI(name, prefixLc)) continue
        seen.add(key)
        const textEdit: TextEdit = { range: textEditRange, newText: name }
        items.push({
          label: name,
          kind: CompletionItemKind.Value,
          detail: 'Tool kit (merged config)',
          insertTextFormat: InsertTextFormat.PlainText,
          textEdit,
        })
      }

      return items
    }

    // Agent name suggestions after agent:
    const inAgentValue = header.agentTargetRanges.find(ar => inRange(pos, ar.range))
      || header.fieldRanges.find(fr => {
        const last = fr.path[fr.path.length - 1]
        return last === 'agent' && inRange(pos, fr.range)
      })
    const looksLikeAgentLine = insideHeaderRange && colonIdx >= 0 && /agent\s*$/i.test(linePrefix2.slice(0, colonIdx).trimEnd())

    if (inAgentValue || looksLikeAgentLine) {
      const specRes = await mergedHeaderSpecForDocDetailed(docText, docDir)
      const spec = specRes.spec
      if (!isLecticHeaderSpec(spec)) return items
      const interNames = buildInterlocutorIndex(spec)

      const edit = computeValueEdit(lineText, pos)
      const prefixLc = edit.prefixLc
      const textEditRange = edit.range

      for (const n of interNames) {
        const name = n.name
        if (prefixLc && !name.toLowerCase().startsWith(prefixLc)) continue
        const textEdit: TextEdit = { range: textEditRange, newText: name }
        items.push({
          label: name,
          kind: CompletionItemKind.Value,
          detail: previewInterlocutor(n).detail,
          documentation: previewInterlocutor(n).documentation,
          insertTextFormat: InsertTextFormat.PlainText,
          textEdit,
        })
      }
      return items
    }

    // Native tool type suggestions after native:
    const inNativeValue = header.nativeTypeRanges.find(nr => inRange(pos, nr.range))
      || header.fieldRanges.find(fr => {
        const last = fr.path[fr.path.length - 1]
        return last === 'native' && inRange(pos, fr.range)
      })
    const looksLikeNativeLine = insideHeaderRange && colonIdx >= 0 && /native\s*$/i.test(linePrefix2.slice(0, colonIdx).trimEnd())

    if (inNativeValue || looksLikeNativeLine) {
      const edit = computeValueEdit(lineText, pos)
      const prefixLc = edit.prefixLc
      const textEditRange = edit.range

      for (const t of NATIVE_SUPPORTED) {
        if (prefixLc && !t.startsWith(prefixLc)) continue
        const textEdit: TextEdit = { range: textEditRange, newText: t }
        items.push({
          label: t,
          kind: CompletionItemKind.Value,
          detail: 'Native tool type',
          insertTextFormat: InsertTextFormat.PlainText,
          textEdit,
        })
      }
      return items
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
  if (colonStart === null) return []

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

