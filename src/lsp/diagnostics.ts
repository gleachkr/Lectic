import type { Diagnostic } from "vscode-languageserver"
import { DiagnosticSeverity, Range, Position } from "vscode-languageserver/node"
import { mergedHeaderSpecForDoc, getBody } from "../parsing/parse"
import { validateLecticHeaderSpec } from "../types/lectic"
import { parseDirectives, nodeContentRaw } from "../parsing/markdown"

function offsetToPosition(text: string, offset: number): Position {
  let line = 0
  let col = 0
  let i = 0
  while (i < offset && i < text.length) {
    const ch = text.charCodeAt(i)
    if (ch === 10 /* \n */) { line++; col = 0 }
    else if (ch === 13 /* \r */) {
      // If CRLF, skip LF next
      if (i + 1 < text.length && text.charCodeAt(i + 1) === 10) i++
      line++; col = 0
    } else {
      col++
    }
    i++
  }
  return Position.create(line, col)
}

function findHeaderRange(text: string): Range | null {
  const re = /^---\n([\s\S]*?)\n(?:---|\.\.\.)/ // same shape as getYaml
  const m = re.exec(text)
  if (!m || !m[0]) return null
  const start = m.index
  const end = start + m[0].length
  return Range.create(offsetToPosition(text, start), offsetToPosition(text, end))
}

export async function buildDiagnostics(
  docText: string,
  docDir: string | undefined
): Promise<Diagnostic[]> {
  const diags: Diagnostic[] = []
  const headerRange = findHeaderRange(docText) ?? Range.create(
    Position.create(0, 0), Position.create(0, 0)
  )
  const headerEndLine = headerRange.end.line

  const spec : unknown = await mergedHeaderSpecForDoc(docText, docDir)

  try {
    if (!validateLecticHeaderSpec(spec)) {
      // Shape is missing interlocutors; mirror CLI error message
      diags.push({
        range: headerRange,
        severity: DiagnosticSeverity.Error,
        source: "lectic",
        message: "YAML Header is missing something. " +
          "One or more interlocutors need to be specified. " +
          "(Use either `interlocutor:` for a single interlocutor, " +
          "or `interlocutors:` for a list, " +
          "and include at least a name and prompt for each interlocutor)."
      })
      return diags
    } else {
      // Collect interlocutor and macro names for cross-refs
      const names: string[] = []
      const seen = new Set<string>()
      const pushName = (n: string) => {
        const k = n.toLowerCase()
        if (!seen.has(k)) { seen.add(k); names.push(n) }
      }
      if ("interlocutor" in spec) pushName(spec.interlocutor.name)
      if (Array.isArray(spec?.interlocutors)) {
        for (const it of spec.interlocutors) {
          if (typeof it === "object" && typeof it?.name === "string") pushName(it.name)
        }
      }

      // Duplicate interlocutor names (case-insensitive)
      if (spec && typeof spec === "object") {
        const all: string[] = []
        if ("interlocutor" in spec) all.push(spec.interlocutor.name)
        if (Array.isArray(spec?.interlocutors)) {
          for (const it of spec.interlocutors) {
            if (typeof it === "object" && typeof it?.name === "string") all.push(it.name)
          }
        }
        const dupMap = new Map<string, string[]>()
        for (const n of all) {
          const k = n.toLowerCase()
          const arr = dupMap.get(k) ?? []
          arr.push(n)
          dupMap.set(k, arr)
        }
        const dups = [...dupMap.values()].filter(xs => xs.length > 1)
        if (dups.length > 0) {
          const details = dups.map(xs => xs.join(", ")).join("; ")
          diags.push({
            range: headerRange,
            severity: DiagnosticSeverity.Warning,
            source: "lectic",
            message: `Duplicate interlocutor names (case-insensitive): ${details}`
          })
        }
      }

      // Duplicate macro names
      if (Array.isArray(spec?.macros)) {
        const dupMap = new Map<string, string[]>()
        for (const m of spec.macros) {
          if (m && typeof m === "object" && typeof m.name === "string") {
            const k = m.name.toLowerCase()
            const arr = dupMap.get(k) ?? []
            arr.push(m.name)
            dupMap.set(k, arr)
          }
        }
        const dups = [...dupMap.values()].filter(xs => xs.length > 1)
        if (dups.length > 0) {
          const details = dups.map(xs => xs.join(", ")).join("; ")
          diags.push({
            range: headerRange,
            severity: DiagnosticSeverity.Warning,
            source: "lectic",
            message: `Duplicate macro names (case-insensitive): ${details}`
          })
        }
      }

      // Unknown agent tool targets
      const interNamesLower = new Set(names.map(n => n.toLowerCase()))
      function checkTools(tools: any[]) {
        for (const t of tools) {
          if (t && typeof t === "object" && typeof (t as any).agent === "string") {
            const target = (t as any).agent as string
            if (!interNamesLower.has(target.toLowerCase())) {
              diags.push({
                range: headerRange,
                severity: DiagnosticSeverity.Error,
                source: "lectic",
                message: `Agent tool references unknown interlocutor: ${target}`
              })
            }
          }
        }
      }
      if (spec && typeof spec === "object") {
        // single interlocutor tools
        if ("interlocutor" in spec && Array.isArray(spec.interlocutor.tools)) {
          checkTools(spec.interlocutor.tools)
        }
        // list interlocutors
        if (Array.isArray(spec?.interlocutors)) {
          for (const it of spec.interlocutors) {
            if (it && typeof it === "object" && Array.isArray((it as any).tools)) {
              checkTools((it as any).tools)
            }
          }
        }
      }

      // Unknown :ask / :aside references in the body
      try {
        const body = getBody(docText)
        const directives = parseDirectives(body)
        for (const d of directives) {
          const name = (d as any).name?.toLowerCase?.() ?? ""
          if (name === "ask" || name === "aside") {
            const text = nodeContentRaw(d as any, body).trim()
            if (text && !interNamesLower.has(text.toLowerCase())) {
              const start = (d as any).position?.start
              const end = (d as any).position?.end
              const range = (start && end)
                ? Range.create(
                    Position.create(headerEndLine + (start.line - 1), start.column - 1),
                    Position.create(headerEndLine + (end.line - 1), end.column - 1)
                  )
                : headerRange
              diags.push({
                range,
                severity: DiagnosticSeverity.Warning,
                source: "lectic",
                message: `Unknown interlocutor in :${name}[...]: ${text}`
              })
            }
          }
        }
      } catch {
        // ignore body parse errors
      }
      return diags
    }
  } catch (e: any) {
    const message = typeof e?.message === "string" ? e.message : String(e)
    diags.push({
      range: headerRange,
      severity: DiagnosticSeverity.Error,
      source: "lectic",
      message
    })
    return diags
  }
}
