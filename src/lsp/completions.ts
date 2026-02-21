import type {
  CompletionContext,
  CompletionItem,
  CompletionParams,
  Position,
  Range,
  TextEdit,
} from "vscode-languageserver"
import {
  CompletionItemKind,
  InsertTextFormat,
  MarkupKind,
  Range as RangeNS,
} from "vscode-languageserver/node"
import { buildMacroIndex, previewMacro } from "./macroIndex"
import { resolveMacroArgumentCompletions } from "./macroArgumentCompletions"
import { buildInterlocutorIndex, previewInterlocutor } from "./interlocutorIndex"
import { directiveAtPositionFromBundle, findSingleColonStart, computeReplaceRange } from "./directives"
import { isLecticHeaderSpec } from "../types/lectic"
import { mergedHeaderSpecForDocDetailed, getYaml } from "../parsing/parse"
import type { AnalysisBundle } from "./analysisTypes"
import { resolveConfigChain } from "../utils/configDiscovery"
import { mergeValues } from "../utils/merge"
import { buildHeaderRangeIndex } from "./yamlRanges"
import { parseYaml, getValue, itemsOf, stringOf } from "./utils/yamlAst"
import { modelRegistry } from "./models"
import { isObjectRecord } from "../types/guards"
import { inRange } from "./utils/range"
import { startsWithCI } from "./utils/text"
import { effectiveProviderForPath } from "./utils/provider"
import { LLMProvider } from "../types/provider"
import { INTERLOCUTOR_KEYS } from "./interlocutorFields"
import {
  DIRECTIVE_DOCS,
  formatKitDocsMarkdown,
  formatMacroDocsMarkdown,
  oneLine,
  trimText,
} from "./docs"

// Static tool kind catalog for YAML tools arrays
const TOOL_KINDS: Array<{ key: string, detail: string, sort: string }> = [
  { key: 'exec',         detail: 'Execute a command or script',           sort: '01_exec' },
  { key: 'sqlite',       detail: 'SQLite database query tool',            sort: '02_sqlite' },
  { key: 'mcp_command',  detail: 'Local MCP server tool',                 sort: '20_mcp_command' },
  { key: 'mcp_ws',       detail: 'WebSocket MCP server tool',             sort: '21_mcp_ws' },
  { key: 'mcp_shttp',    detail: 'Streamable HTTP MCP tool',              sort: '23_mcp_shttp' },
  { key: 'agent',        detail: 'Interlocutor-as-tool agent',            sort: '10_agent' },
  { key: 'a2a',          detail: 'A2A remote agent tool',                 sort: '10_a2a' },
  { key: 'think_about',  detail: 'Scratchpad reasoning tool',             sort: '11_think' },
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

type UseRefKind = "hook" | "env" | "sandbox"

type UseDefCatalog = {
  hook: string[]
  env: string[]
  sandbox: string[]
}

function readNamedDefs(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []

  const out: string[] = []
  const seen = new Set<string>()

  for (const entry of raw) {
    if (!isObjectRecord(entry)) continue
    const name = entry["name"]
    if (typeof name !== "string") continue

    const key = name.toLowerCase()
    if (seen.has(key)) continue

    seen.add(key)
    out.push(name)
  }

  return out
}

async function collectUseDefCatalog(
  docText: string,
  docDir: string | undefined,
): Promise<UseDefCatalog> {
  try {
    const headerYaml = getYaml(docText)
    const chain = await resolveConfigChain({
      includeSystem: true,
      workspaceStartDir: docDir,
      document:
        typeof headerYaml === "string" && headerYaml.length > 0
          ? { yaml: headerYaml, dir: docDir }
          : undefined,
    })

    let merged: unknown = {}
    for (const source of chain.sources) {
      if (source.parsed === null || source.parsed === undefined) continue
      merged = mergeValues(merged, source.parsed)
    }

    if (!isObjectRecord(merged)) {
      return { hook: [], env: [], sandbox: [] }
    }

    return {
      hook: readNamedDefs(merged["hook_defs"]),
      env: readNamedDefs(merged["env_defs"]),
      sandbox: readNamedDefs(merged["sandbox_defs"]),
    }
  } catch {
    return { hook: [], env: [], sandbox: [] }
  }
}

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
  bundle?: AnalysisBundle,
  triggerContext?: CompletionContext,
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

    // Interlocutor name suggestions for interlocutor.name fields
    const isInterlocutorNamePath = (p: (string | number)[]): boolean => {
      if (p.length === 2 && p[0] === 'interlocutor' && p[1] === 'name') return true
      if (
        p.length === 3 &&
        p[0] === 'interlocutors' &&
        typeof p[1] === 'number' &&
        p[2] === 'name'
      ) return true
      return false
    }

    const inRangeOrTrailingSpace = (r: Range): boolean => {
      if (inRange(pos, r)) return true
      if (pos.line !== r.end.line) return false
      if (pos.character < r.end.character) return false
      const between = lineText.slice(r.end.character, pos.character)
      return between.trim() === ''
    }

    const linePrefixWithCursor = lineText.slice(0, pos.character)
    const useColonIdx = linePrefixWithCursor.lastIndexOf(':')
    const looksLikeUseLine =
      insideHeaderRange
      && useColonIdx >= 0
      && /use\s*$/i.test(
        linePrefixWithCursor.slice(0, useColonIdx).trimEnd()
      )

    let useKind: UseRefKind | null = null

    const useRangeHit = header.useTargetRanges.find(ur =>
      inRangeOrTrailingSpace(ur.range)
    )
    if (useRangeHit) {
      useKind = useRangeHit.kind
    }

    if (!useKind && looksLikeUseLine) {
      const contextHit = header.fieldRanges
        .filter(fr => {
          const last = fr.path[fr.path.length - 1]
          if (last !== 'hooks' && last !== 'env' && last !== 'sandbox') {
            return false
          }
          return inRangeOrTrailingSpace(fr.range)
        })
        .sort((a, b) => b.path.length - a.path.length)[0]

      const last = contextHit?.path[contextHit.path.length - 1]
      if (last === 'hooks') {
        useKind = 'hook'
      } else if (last === 'env' || last === 'sandbox') {
        useKind = last
      }
    }

    if (useKind) {
      const defs = await collectUseDefCatalog(docText, docDir)
      const names = defs[useKind]

      const edit = computeValueEdit(lineText, pos)
      const prefixLc = edit.prefixLc
      const textEditRange = edit.range

      for (const name of names) {
        if (prefixLc && !startsWithCI(name, prefixLc)) continue

        const textEdit: TextEdit = {
          range: textEditRange,
          newText: name,
        }

        items.push({
          label: name,
          kind: CompletionItemKind.Value,
          detail: `${useKind} definition`,
          insertTextFormat: InsertTextFormat.PlainText,
          textEdit,
        })
      }

      return items
    }

    const interlocutorNameHit = header.fieldRanges.find(fr => {
      if (!isInterlocutorNamePath(fr.path)) return false
      return inRangeOrTrailingSpace(fr.range)
    })

    if (interlocutorNameHit) {
      const specRes = await mergedHeaderSpecForDocDetailed(docText, docDir)
      const spec = specRes.spec

      const names: Array<{ name: string, prompt?: string }> = []
      const seen = new Set<string>()

      const pushName = (name: string, prompt?: string) => {
        const key = name.toLowerCase()
        if (seen.has(key)) return
        seen.add(key)
        names.push({ name, prompt })
      }

      if (isLecticHeaderSpec(spec)) {
        for (const inter of buildInterlocutorIndex(spec)) {
          pushName(inter.name, inter.prompt)
        }
      } else if (isObjectRecord(spec)) {
        const single = spec['interlocutor']
        if (isObjectRecord(single) && typeof single['name'] === 'string') {
          const p = typeof single['prompt'] === 'string' ? single['prompt'] : undefined
          pushName(single['name'], p)
        }
        const list = spec['interlocutors']
        if (Array.isArray(list)) {
          for (const it of list) {
            if (!isObjectRecord(it) || typeof it['name'] !== 'string') continue
            const p = typeof it['prompt'] === 'string' ? it['prompt'] : undefined
            pushName(it['name'], p)
          }
        }
      }

      const edit = computeValueEdit(lineText, pos)
      const prefixLc = edit.prefixLc
      const textEditRange = edit.range

      for (const n of names) {
        if (prefixLc && !startsWithCI(n.name, prefixLc)) continue
        const textEdit: TextEdit = { range: textEditRange, newText: n.name }
        items.push({
          label: n.name,
          kind: CompletionItemKind.Value,
          detail: 'Interlocutor name',
          documentation: n.prompt,
          insertTextFormat: InsertTextFormat.PlainText,
          textEdit,
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

      const mergedKits = spec.kits ?? []

      const edit = computeValueEdit(lineText, pos)
      const prefixLc = edit.prefixLc
      const textEditRange = edit.range

      const seen = new Set<string>()
      for (const kit of mergedKits) {
        const name = kit.name
        const desc = kit.description
        const descOneLine = desc ? oneLine(desc) : undefined

        const key = name.toLowerCase()
        if (seen.has(key)) continue
        if (prefixLc && !startsWithCI(name, prefixLc)) continue
        seen.add(key)

        const textEdit: TextEdit = { range: textEditRange, newText: name }
        items.push({
          label: name,
          labelDetails: descOneLine
            ? { description: trimText(descOneLine, 80) }
            : undefined,
          kind: CompletionItemKind.Value,
          detail: descOneLine
            ? `Tool kit — ${trimText(descOneLine, 100)}`
            : "Tool kit",
          documentation: {
            kind: MarkupKind.Markdown,
            value: formatKitDocsMarkdown(kit),
          },
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

  // 1) Inside :ask[...]/:aside[...]
  const dctx = bundle ? directiveAtPositionFromBundle(docText, pos, bundle) : null
  if (dctx && dctx.insideBrackets) {

    if (dctx.key === "ask" || dctx.key === "aside") {
      const specRes = await mergedHeaderSpecForDocDetailed(docText, docDir)
      const spec = specRes.spec
      if (!isLecticHeaderSpec(spec)) return items

      const innerText = dctx.innerPrefix.toLowerCase()
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

    if (dctx.key === "env") {
      const prefix = dctx.innerPrefix.trim().toLowerCase()
      const envVars = [
        "LECTIC_CONFIG",
        "LECTIC_DATA",
        "LECTIC_CACHE",
        "LECTIC_STATE",
        "LECTIC_TEMP",
        "LECTIC_FILE",
        "LECTIC_INTERLOCUTOR",
        "LECTIC_MODEL",
        ...Object.keys(process.env)
      ]

      for (const v of envVars) {
        if (prefix && !v.toLowerCase().startsWith(prefix)) continue
        const textEdit: TextEdit = {
          range: RangeNS.create(dctx.innerStart, pos),
          newText: v,
        }
        items.push({
          label: v,
          kind: CompletionItemKind.Variable,
          detail: "Environment variable",
          insertTextFormat: InsertTextFormat.PlainText,
          textEdit,
        })
      }

      return items
    }

    const specRes = await mergedHeaderSpecForDocDetailed(docText, docDir)
    const spec = specRes.spec
    if (!isLecticHeaderSpec(spec)) return []

    const macros = buildMacroIndex(spec)
    const macro = macros.find(m => m.name.toLowerCase() === dctx.key)
    if (!macro) return []

    const resolved = await resolveMacroArgumentCompletions(
      macro,
      dctx.innerPrefix,
      triggerContext,
    )

    if (resolved.blockedByTriggerPolicy) {
      return []
    }

    for (const entry of resolved.entries) {
      items.push({
        label: entry.completion,
        kind: CompletionItemKind.Value,
        detail: entry.detail,
        documentation: entry.documentation,
        insertTextFormat: InsertTextFormat.PlainText,
        textEdit: {
          range: RangeNS.create(dctx.innerStart, pos),
          newText: entry.completion,
        },
      })
    }

    return items
  }

  // 2) Directive keywords on ':' (and macro names as directives)
  if (colonStart === null) return []

  const prefix = lineText.slice(colonStart + 1, pos.character).toLowerCase()
  // Add macro names as directive completions: :name[]
  const specRes = await mergedHeaderSpecForDocDetailed(docText, docDir)
  const spec = specRes.spec
  if (isLecticHeaderSpec(spec)) {
    const macros = buildMacroIndex(spec)
    for (const m of macros) {
      const key = m.name
      if (!key.toLowerCase().startsWith(prefix)) continue
      const pm = previewMacro(m)

      const descriptionOneLine = pm.description
        ? oneLine(pm.description)
        : undefined

      const detail = descriptionOneLine
        ? `:${key} — macro — ${trimText(descriptionOneLine, 120)}`
        : `:${key} — macro`

      const hasArgumentCompletions = m.completions !== undefined
      const snippet = hasArgumentCompletions
        ? `:${key}[$0]`
        : `:${key}[]$0`
      const triggerSuggest = hasArgumentCompletions
        ? { title: "trigger suggest", command: "editor.action.triggerSuggest" }
        : undefined

      items.push({
        label: key,
        labelDetails: descriptionOneLine
          ? { description: descriptionOneLine }
          : undefined,
        kind: CompletionItemKind.Snippet,
        detail,
        documentation: {
          kind: MarkupKind.Markdown,
          value: formatMacroDocsMarkdown(key, pm, { documentationLimit: 800 }),
        },
        insertTextFormat: InsertTextFormat.Snippet,
        sortText: `50_macro_${key.toLowerCase()}`,
        textEdit: {
          range: computeReplaceRange(pos.line, colonStart, pos.character),
          newText: snippet,
        },
        command: triggerSuggest,
      })
    }
  }

  for (const d of DIRECTIVE_DOCS) {
    if (!d.key.startsWith(prefix)) continue

    const textEdit: TextEdit = {
      range: computeReplaceRange(pos.line, colonStart, pos.character),
      newText: d.insert,
    }

    const triggerSuggest = d.triggerSuggest
      ? { title: "trigger suggest", command: "editor.action.triggerSuggest" }
      : undefined

    items.push({
      label: d.key,
      kind: CompletionItemKind.Snippet,
      detail: `:${d.key} — ${d.title}`,
      documentation: d.body,
      insertTextFormat: InsertTextFormat.Snippet,
      textEdit,
      command: triggerSuggest,
      sortText: d.sortText,
    })
  }

  return items
}

