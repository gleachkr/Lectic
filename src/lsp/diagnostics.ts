import type {
  Diagnostic,
  Range as LspRangeT,
} from "vscode-languageserver"
import {
  DiagnosticSeverity,
  Range as LspRange,
  Position as LspPosition,
} from "vscode-languageserver/node"
import { mergedHeaderSpecForDoc, getYaml } from "../parsing/parse"
import { directivesFromAst, nodeContentRaw, referencesFromAst, nodeRaw } from "../parsing/markdown"
import { buildHeaderRangeIndex, type HeaderRangeIndex } from "./yamlRanges"
import { validateHeaderShape } from "./headerValidate"
import * as YAML from "yaml"
import { offsetToPosition } from "./positions"
import { findUrlRangeInNodeRaw } from "./linkTargets"
import { expandEnv } from "../utils/replace"
import { normalizeUrl, hasGlobChars, globHasMatches, pathExists } from "./pathUtils"
import type { Root } from "mdast"

// Narrow header structures for diagnostics. These are minimal shapes
// we actually use in LSP; runtime uses richer types elsewhere.
export type InterlocutorLike = {
  name?: string
  prompt?: string
  tools?: unknown[]
}
export type MacroLike = { name?: string }
export type HeaderLike = {
  interlocutor?: InterlocutorLike
  interlocutors?: InterlocutorLike[]
  macros?: MacroLike[]
}

// Helper re-exported from positions.ts is imported above

// Detect YAML header range in the document
function findHeaderRange(text: string): LspRangeT | null {
  const re = /^---\n([\s\S]*?)\n(?:---|\.\.\.)/
  const m = re.exec(text)
  if (!m || !m[0]) return null
  const start = m.index
  const end = start + m[0].length
  return LspRange.create(offsetToPosition(text, start), offsetToPosition(text, end))
}

// For missing-key diagnostics, try an enclosing mapping range
function tryEnclosingRange(
  headerIndex: HeaderRangeIndex | null,
  path: (string | number)[]
): LspRangeT | null {
  if (!headerIndex) return null
  for (let depth = path.length - 1; depth >= 0; depth--) {
    const p = path.slice(0, depth)
    const rs = headerIndex.findRangesByPath(p)
    if (rs.length > 0) return rs[0]
  }
  return null
}

function isObjectRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null
}
function sanitizeInterlocutorLike(v: unknown): InterlocutorLike | undefined {
  if (!isObjectRecord(v)) return undefined
  const obj = v 
  const out: InterlocutorLike = {}
  const name = obj["name"]
  if (typeof name === "string") out.name = name
  const prompt = obj["prompt"]
  if (typeof prompt === "string") out.prompt= prompt
  const tools = obj["tools"]
  if (Array.isArray(tools)) out.tools = tools as unknown[]
  return out
}
function sanitizeMacroLike(v: unknown): MacroLike | undefined {
  if (!isObjectRecord(v)) return undefined
  const obj = v 
  const out: MacroLike = {}
  const name = obj["name"]
  if (typeof name === "string") out.name = name
  return out
}
function sanitizeHeaderLike(v: unknown): HeaderLike {
  const out: HeaderLike = {}
  if (!isObjectRecord(v)) return out
  const obj = v
  if ("interlocutor" in obj) {
    const i = sanitizeInterlocutorLike(obj["interlocutor"])
    if (i) out.interlocutor = i
  }
  const inters = obj["interlocutors"]
  if (Array.isArray(inters)) {
    const xs = (inters as unknown[])
      .map(sanitizeInterlocutorLike).filter(Boolean) as InterlocutorLike[]
    if (xs.length > 0) out.interlocutors = xs
  }
  const macros = obj["macros"]
  if (Array.isArray(macros)) {
    const ms = (macros as unknown[])
      .map(sanitizeMacroLike).filter(Boolean) as MacroLike[]
    if (ms.length > 0) out.macros = ms
  }
  return out
}

// Parse the local YAML header (unmerged) for precise path→range mapping
function parseLocalHeader(docText: string): unknown {
  const localYaml = getYaml(docText) ?? ""
  const parsed = YAML.parse(localYaml)
  return (parsed && typeof parsed === "object") ? parsed : {}
}

// Project-wide merged spec for semantics (includes system/workspace)
async function loadMergedHeader(
  docText: string, docDir: string | undefined
): Promise<HeaderLike> {
  const spec = await mergedHeaderSpecForDoc(docText, docDir)
  return sanitizeHeaderLike(spec)
}

// Map non-throwing header issues to LSP diagnostics with precise ranges
function mapHeaderIssues(
  issues: ReturnType<typeof validateHeaderShape>,
  headerIndex: HeaderRangeIndex | null,
  fallback: LspRangeT
): Diagnostic[] {
  const out: Diagnostic[] = []
  const sev = (s: "error" | "warning") =>
    s === "error" ? DiagnosticSeverity.Error : DiagnosticSeverity.Warning
  for (const issue of issues) {
    const ranges = headerIndex?.findRangesByPath(issue.path) ?? []
    if (ranges.length > 0) {
      for (const r of ranges) {
        out.push({
          range: r, severity: sev(issue.severity), source: "lectic",
          message: issue.message
        })
      }
    } else {
      const enclosing = tryEnclosingRange(headerIndex, issue.path) ?? fallback
      out.push({
        range: enclosing, severity: sev(issue.severity), source: "lectic",
        message: issue.message
      })
    }
  }
  return out
}

function emitLocalDuplicateWarnings(
  entries: Array<{ name: string, range: LspRangeT }>,
  label: "interlocutor" | "macro"
): Diagnostic[] {
  const map = new Map<string, LspRangeT[]>()
  for (const { name, range } of entries) {
    const arr = map.get(name) ?? []
    arr.push(range)
    map.set(name, arr)
  }
  const diags: Diagnostic[] = []
  for (const [name, ranges] of map.entries()) {
    if (ranges.length > 1) {
      for (const r of ranges) {
        diags.push({
          range: r,
          severity: DiagnosticSeverity.Warning,
          source: "lectic",
          message: `Duplicate ${label} name: ${name}`
        })
      }
    }
  }
  return diags
}

async function emitLinkDiagnostics(
  ast: Root,
  docText: string,
  docDir: string | undefined
): Promise<Diagnostic[]> {
  const out: Diagnostic[] = []
  const refs = referencesFromAst(ast)
  for (const node of refs) {
    const s = node.position?.start
    const e = node.position?.end
    if (!s || !e || s.offset == null || e.offset == null) continue

    const raw = nodeRaw(node, docText)
    const dest = node.url as string | undefined
    if (typeof dest !== 'string') continue

    const urlRange = findUrlRangeInNodeRaw(raw, s.offset, dest)
    if (!urlRange) continue
    const [innerStartOff, innerEndOff] = urlRange

    const url = docText.slice(innerStartOff, innerEndOff)
    const norm = normalizeUrl(url, docDir)

    // Only check local file paths
    if (norm.kind === 'remote') continue

    const range = LspRange.create(
      offsetToPosition(docText, innerStartOff),
      offsetToPosition(docText, innerEndOff)
    )

    // Special case: file:// URL must be absolute after env expansion
    const trimmed = url.trim()
    if (trimmed.startsWith('file://')) {
      const rest = trimmed.slice('file://'.length)
      const expanded = expandEnv(rest, docDir ? { PWD : docDir } : {})
      if (!expanded.startsWith('/')) {
        out.push({
          range,
          severity: DiagnosticSeverity.Warning,
          source: "lectic",
          message: "Relative paths are not allowed in file:// URLs. " +
            "Use an absolute path like file://$PWD/... or file:///..."
        })
        continue
      }
    }

    if (hasGlobChars(norm.fsPath)) {
      const matches = await globHasMatches(norm.fsPath, docDir)
      if (!matches) {
        out.push({
          range,
          severity: DiagnosticSeverity.Warning,
          source: "lectic",
          message: `Glob pattern matched no files: ${norm.fsPath}`
        })
      }
      continue
    }

    const exists = await pathExists(norm.fsPath)
    if (!exists) {
      out.push({
        range,
        severity: DiagnosticSeverity.Warning,
        source: "lectic",
        message: `Path does not exist: ${norm.fsPath}`
      })
    }
  }
  return out
}

function hasAnyInterlocutor(merged: HeaderLike): boolean {
  if (isObjectRecord(merged.interlocutor)) return true
  if (Array.isArray(merged.interlocutors) && merged.interlocutors.length > 0)
    return true
  return false
}

function collectInterlocutorNames(spec: HeaderLike): string[] {
  const names: string[] = []
  const seen = new Set<string>()
  const push = (n?: string) => {
    if (typeof n !== "string") return
    if (!seen.has(n)) { seen.add(n); names.push(n) }
  }
  if (spec.interlocutor && typeof spec.interlocutor === "object")
    push(spec.interlocutor.name)
  if (Array.isArray(spec.interlocutors))
    for (const it of spec.interlocutors)
      if (it && typeof it === "object") push(it.name)
  return names
}

function collectAllInterlocutors(spec: HeaderLike): InterlocutorLike[] {
  const list: InterlocutorLike[] = []
  if (spec.interlocutor && typeof spec.interlocutor === "object")
    list.push(spec.interlocutor)
  if (Array.isArray(spec.interlocutors))
    for (const it of spec.interlocutors)
      if (it && typeof it === "object") list.push(it)
  return list
}


function emitUnknownAgentTargetErrors(
  spec: HeaderLike,
  headerIndex: HeaderRangeIndex | null,
  headerRange: LspRangeT,
  knownNames: string[]
): Diagnostic[] {
  const diags: Diagnostic[] = []
  const knownSet = new Set(knownNames)
  const agentRanges = headerIndex?.agentTargetRanges ?? []

  const checkTools = (tools: unknown[]) => {
    for (const t of tools) {
      if (!t || typeof t !== "object") continue
      const agent = (t as { agent?: unknown }).agent
      if (typeof agent !== "string") continue
      if (knownSet.has(agent)) continue
      const matches = agentRanges.filter(a => a.target === agent)
      if (matches.length > 0) {
        for (const m of matches) {
          diags.push({
            range: m.range,
            severity: DiagnosticSeverity.Error,
            source: "lectic",
            message: `Agent tool references unknown interlocutor: ${agent}`
          })
        }
      } else {
        diags.push({
          range: headerRange,
          severity: DiagnosticSeverity.Error,
          source: "lectic",
          message: `Agent tool references unknown interlocutor: ${agent}`
        })
      }
    }
  }

  for (const inter of collectAllInterlocutors(spec)) {
    const tools = inter.tools
    if (Array.isArray(tools)) checkTools(tools)
  }
  return diags
}

function emitUnknownDirectiveWarnings(
  ast: Root,
  docText: string,
  headerRange: LspRangeT,
  knownNames: string[]
): Diagnostic[] {
  const diags: Diagnostic[] = []
  try {
    const directives = directivesFromAst(ast)
    const known = new Set(knownNames)
    for (const d of directives) {
      const name = (d.name ?? "")
      if (name !== "ask" && name !== "aside") continue
      const text = nodeContentRaw(d, docText).trim()
      if (!text) continue
      if (known.has(text)) continue
      const s = d.position?.start
      const e = d.position?.end
      const range = (s && e)
        ? LspRange.create(
            LspPosition.create(s.line - 1, s.column - 1),
            LspPosition.create(e.line - 1, e.column - 1)
          )
        : headerRange
      diags.push({
        range,
        severity: DiagnosticSeverity.Warning,
        source: "lectic",
        message: `Unknown interlocutor in :${name}[...]: ${text}`
      })
    }
  } catch {
    // ignore body parse errors
  }
  return diags
}

export async function buildDiagnostics(
  ast: Root,
  docText: string,
  docDir?: string
): Promise<Diagnostic[]> {
  const diags: Diagnostic[] = []
  const headerRange = findHeaderRange(docText) ??
    LspRange.create(LspPosition.create(0, 0), LspPosition.create(0, 0))
  const headerIndex = buildHeaderRangeIndex(docText)

  // 1) Local duplicate warnings (precise ranges)
  const headerInterNames = headerIndex?.interlocutorNameRanges ?? []
  const headerMacroNames = headerIndex?.macroNameRanges ?? []
  const localInterDupDiags = emitLocalDuplicateWarnings(headerInterNames, "interlocutor")
  const localMacroDupDiags = emitLocalDuplicateWarnings(headerMacroNames, "macro")
  diags.push(...localInterDupDiags, ...localMacroDupDiags)

  // 2) Targeted field diagnostics from local YAML, filtered by merged spec
  const localSpec = parseLocalHeader(docText)
  const mergedSpec = await loadMergedHeader(docText, docDir)

  const issues = validateHeaderShape(localSpec)
    .filter(issue => {
      // Suppress missing-prompt errors when the effective merged spec
      // provides a prompt from lower-precedence config.
      if (issue.code !== "interlocutor.prompt.missing") return true
      const p = issue.path
      if (p[0] === "interlocutor") {
        const mergedPrompt = mergedSpec?.interlocutor?.prompt
        return !(typeof mergedPrompt === "string")
      }
      if (p.length >= 3 && p[0] === "interlocutors" && typeof p[1] === "number") {
        const idx = p[1]
        const localArray = isObjectRecord(localSpec) ? localSpec["interlocutors"] : undefined
        const localName = Array.isArray(localArray) && 
                          isObjectRecord(localArray[idx]) && 
                          typeof localArray[idx]["name"] === "string" 
                              ? localArray[idx]["name"]
                              : undefined
        const mergedList = mergedSpec?.interlocutors
        if (typeof localName === "string") {
          if (Array.isArray(mergedList)) {
            const merged = mergedList.find(it => typeof it?.name === "string" && it.name === localName)
            if (merged && typeof merged.prompt === "string") return false
          }
          const mi = mergedSpec?.interlocutor
          if (mi && typeof mi.name === "string" && mi.name === localName && typeof mi.prompt === "string") {
            return false
          }
        }
      }
      return true
    })
  diags.push(...mapHeaderIssues(issues, headerIndex, headerRange))

  // 3) Coarse missing-interlocutor check on merged spec
  if (!hasAnyInterlocutor(mergedSpec)) {
    const msg = "YAML Header is missing something. " +
      "One or more interlocutors need to be specified. " +
      "(Use either `interlocutor:` for a single interlocutor, " +
      "or `interlocutors:` for a list, " +
      "and include at least a name and prompt for each interlocutor)."
    if (!diags.some(d => d.message === msg)) {
      diags.push({
        range: headerRange,
        severity: DiagnosticSeverity.Error,
        source: "lectic",
        message: msg
      })
    }
    return diags
  }


  // 4) Unknown agent targets (precise ranges where possible)
  const knownNames = collectInterlocutorNames(mergedSpec)
  diags.push(
    ...emitUnknownAgentTargetErrors(
      mergedSpec, headerIndex, headerRange, knownNames
    )
  )

  // 6) Unknown :ask and :aside references in the body
  diags.push(
    ...emitUnknownDirectiveWarnings(
      ast, docText, headerRange, knownNames
    )
  )

  // 7) Link diagnostics: missing local file and empty glob
  diags.push(
    ...await emitLinkDiagnostics(ast, docText, docDir)
  )

  return diags
}
