import type { Hover, Position } from "vscode-languageserver"
import { MarkupKind, Range as LspRange } from "vscode-languageserver/node"
import { directiveAtPositionFromBundle } from "./directives"
import { linkTargetAtPositionFromBundle } from "./linkTargets"
import { offsetToPosition, positionToOffset } from "./positions"
import { mergedHeaderSpecForDocDetailed } from "../parsing/parse"
import { isLecticHeaderSpec } from "../types/lectic"
import { buildMacroIndex, previewMacro } from "./macroIndex"
import { buildHeaderRangeIndex } from "./yamlRanges"
import { inRange } from "./utils/range"
import { normalizeUrl, readHeadPreview, pathExists, hasGlobChars } from "./utils/path"
import {
  code,
  codeFence,
  codeFenceLang,
  directiveDocFor,
  formatKitDocsMarkdown,
  formatMacroDocsMarkdown,
} from "./docs"
import { stat } from "fs/promises"
import type { AnalysisBundle } from "./analysisTypes"
import { unescapeTags, extractElements, unwrap } from "../parsing/xml" 
import { deserializeInlineAttachment } from "../types/inlineAttachment"
import { stringify } from "yaml"

export async function computeHover(
  docText: string,
  pos: Position,
  docDir: string | undefined,
  bundle: AnalysisBundle
): Promise<Hover | null> {
  // 1) Directive hover (including macro name hover)
  const dctx = directiveAtPositionFromBundle(docText, pos, bundle)
  if (dctx && dctx.key) {
    // Macros are invoked as :name[] or :name[args].
    {
      const specRes = await mergedHeaderSpecForDocDetailed(docText, docDir)
      if (isLecticHeaderSpec(specRes.spec)) {
        const macros = buildMacroIndex(specRes.spec)

        const found = macros.find(
          m => m.name.toLowerCase() === dctx.key.toLowerCase()
        )
        if (found) {
          const pm = previewMacro(found)
          const value = formatMacroDocsMarkdown(found.name, pm)

          return {
            contents: { kind: MarkupKind.Markdown, value },
            range: LspRange.create(dctx.nodeStart, dctx.nodeEnd),
          }
        }
      }
    }

    const info = directiveDocFor(dctx.key)
    if (info) {
      return {
        contents: {
          kind: MarkupKind.Markdown,
          value: `:${info.key} — ${info.title}\n\n${info.body}`,
        },
        range: LspRange.create(dctx.nodeStart, dctx.nodeEnd),
      }
    }
  }

  // 1.5) Kit hover for YAML header kit references and definitions
  const kitHover = await kitYamlHover(docText, pos, docDir)
  if (kitHover) return kitHover

  // 2) Tool-call block hover: anywhere inside the call shows inputs
  //    and results (previews derived from serialized content only)
  const toolHover = toolBlockHover(docText, pos, bundle)
  if (toolHover) return toolHover

  // 2.5) Inline attachment hover: show command and content
  const attachHover = inlineAttachmentHover(docText, pos, bundle)
  if (attachHover) return attachHover

  // 3) Link hover: small preview for local text files
  const hrefHover = await linkHover(docText, pos, docDir, bundle)
  if (hrefHover) return hrefHover

  return null
}


async function kitYamlHover(
  docText: string,
  pos: Position,
  docDir: string | undefined
): Promise<Hover | null> {
  const idx = buildHeaderRangeIndex(docText)
  if (!idx) return null

  const refHit = idx.kitTargetRanges.find(kr => inRange(pos, kr.range))
  const defHit = idx.kitNameRanges.find(kn => inRange(pos, kn.range))

  const targetName = refHit?.target ?? defHit?.name
  const hitRange = refHit?.range ?? defHit?.range
  if (!targetName || !hitRange) return null

  const specRes = await mergedHeaderSpecForDocDetailed(docText, docDir)
  if (!isLecticHeaderSpec(specRes.spec)) return null

  const kits = specRes.spec.kits ?? []
  const found = kits.find(k => k.name.toLowerCase() === targetName.toLowerCase())
  if (!found) return null

  const value = formatKitDocsMarkdown(found)

  return {
    contents: { kind: MarkupKind.Markdown, value },
    range: hitRange,
  }
}

async function linkHover(
  docText: string,
  pos: Position,
  docDir: string | undefined,
  bundle: AnalysisBundle
): Promise<Hover | null> {
  const hit = linkTargetAtPositionFromBundle(docText, pos, bundle)
  if (hit) {
    return await linkPreview(docText, hit.startOff, hit.endOff, docDir)
  }
  return null
}

async function linkPreview(docText: string, startOff: number, endOff: number, docDir: string | undefined): Promise<Hover | null> {
  const url = docText.slice(startOff, endOff)
  const norm = normalizeUrl(url, docDir)
  const range = LspRange.create(offsetToPosition(docText, startOff), offsetToPosition(docText, endOff))
  return await linkPreviewWith(norm, range, docDir)
}

import type { Range } from "vscode-languageserver"

async function linkPreviewWith(norm: ReturnType<typeof normalizeUrl>, range: Range, docDir: string | undefined): Promise<Hover | null> {
  const parts: string[] = []
  parts.push(`Path: ${code(norm.display)}`)

  if (norm.kind === 'remote') {
    parts.push("No preview: remote URL")
    return {
      contents: { kind: MarkupKind.Markdown, value: parts.join("\n\n") },
      range
    }
  }

  // Glob hover: list a truncated set of matches
  if (hasGlobChars(norm.fsPath)) {
    const { matches, truncated, total } = await listGlobMatches(norm.fsPath, docDir, 20)
    if (matches.length === 0) {
      parts.push("No preview: no matches for glob")
    } else {
      const list = matches.map(m => `- ${m}`).join("\n")
      const header = truncated ? `Matches (${total} matches, truncated):` : "Matches:"
      parts.push(`${header}\n\n${list}`)
    }
    return {
      contents: { kind: MarkupKind.Markdown, value: parts.join("\n\n") },
      range
    }
  }

  const exists = await pathExists(norm.fsPath)
  if (!exists) {
    parts.push("No preview: file not found")
    return {
      contents: { kind: MarkupKind.Markdown, value: parts.join("\n\n") },
      range
    }
  }

  try {
    const st = await stat(norm.fsPath)
    if (st.isDirectory()) {
      parts.push("No preview: directory")
      return {
        contents: { kind: MarkupKind.Markdown, value: parts.join("\n\n") },
        range
      }
    }
  } catch {
    // ignore stat errors; fall through to preview logic
  }

  const preview = await readHeadPreview(norm.fsPath)
  if (preview == null) {
    parts.push("No preview: non-text or unreadable")
    return {
      contents: { kind: MarkupKind.Markdown, value: parts.join("\n\n") },
      range
    }
  }
  if (preview.length === 0) {
    parts.push("No preview: empty file")
    return {
      contents: { kind: MarkupKind.Markdown, value: parts.join("\n\n") },
      range
    }
  }

  const fenced = codeFence(preview)
  parts.push(fenced)

  return {
    contents: {
      kind: MarkupKind.Markdown,
      value: parts.join("\n\n")
    },
    range
  }
}


function langFor(mediaType?: string | null): string | null {
  if (!mediaType) return null
  const mt = mediaType.toLowerCase()
  // Treat +json as json regardless of preceding subtype (e.g. ld+json)
  if (/(?:^|\+)json$/.test(mt) || mt.includes("+json")) return "json"
  // Shell-like exceptions
  if (mt.includes("shell") || /(?:^|\/)x-sh$/.test(mt) || /(?:^|\/)sh$/.test(mt)) return "sh"
  // Generic application/* or text/* → subtype
  const m = /^(application|text)\/(.+)$/.exec(mt)
  if (m && m[2]) {
    const sub = m[2]
    // Common cleanups: strip vendor prefixes like x-
    const cleaned = sub.replace(/^x-/, "")
    return cleaned
  }
  return null
}

function isDisplayableMedia(mediaType?: string | null): boolean {
  if (!mediaType) return true
  const mt = mediaType.toLowerCase()
  return mt.startsWith("text/") || mt.startsWith("application/")
}

function genericDeserialize(text: string): unknown {
  const trimmed = text.trim()
  if (trimmed.startsWith("<object>") && trimmed.endsWith("</object>")) {
     try {
       const inner = unwrap(trimmed, "object")
       const obj: Record<string, unknown> = {}
       const elements = extractElements(inner)
       for (const el of elements) {
           const t = parseTag(el)
           if (t) {
               const valText = unwrap(el, t.name)
               obj[t.name] = genericDeserialize(valText)
           }
       }
       return obj
     } catch {
       return unescapeTags(text)
     }
  } 
  if (trimmed.startsWith("<array>") && trimmed.endsWith("</array>")) {
     try {
       const inner = unwrap(trimmed, "array")
       const arr: unknown[] = []
       const elements = extractElements(inner)
       for (const el of elements) {
           const t = parseTag(el)
           if (t && t.name === "item") {
                const valText = unwrap(el, "item")
                arr.push(genericDeserialize(valText))
           }
       }
       return arr
     } catch {
       return unescapeTags(text)
     }
  }
  return unescapeTags(text)
}

function prettyBodyFor(raw: string, mediaType? : string, escape : boolean = true): { body: string, lang: string | null } {
  // raw here is serialized text with line markers and <│ escapes.
  // We must unescape before pretty printing.
  const lang = langFor(mediaType)
  if (mediaType && mediaType.toLowerCase().includes("json")) {
    try {
      const unesc = escape ? unescapeTags(raw) : raw
      const parsed = JSON.parse(unesc)
      const pretty = JSON.stringify(parsed, null, 2)
      return { body: pretty, lang: "json" }
    } catch {
      // Fall through to generic unescape below.
    }
  }

  // Try generic deserialization for Lectic's object/array XML
  const trimmed = raw.trim()
  if (trimmed.startsWith("<object>") || trimmed.startsWith("<array>")) {
      try {
          const obj = genericDeserialize(trimmed)
          // Use YAML for display
          const yamlStr = stringify(obj)
          return { body: yamlStr.trim(), lang: "yaml" }
      } catch {
          // Fall back to unescaping
      }
  }

  const body = escape ? unescapeTags(raw) : raw
  return { body, lang }
}

function elementsUnder(serialized: string, parentTag: string): string[] {
  const open = `<${parentTag}>`
  const close = `</${parentTag}>`
  const start = serialized.indexOf(open)
  if (start < 0) return []
  // Assuming well‑formed serialized XML produced by Lectic, there is a
  // single outer <parentTag> ... </parentTag> wrapper. Using the first
  // opening and the last closing reliably slices the wrapper even when
  // nested <parentTag> blocks exist inside.
  const end = serialized.lastIndexOf(close)
  if (end < 0 || end <= start) return []
  const inner = serialized.slice(start + open.length, end)
  return extractElements(inner)
}

function parseTag(el: string): { name: string, attrs: string } | null {
  const m = /^<([a-zA-Z][a-zA-Z0-9_-]*)\b([^>]*)>/.exec(el)
  if (!m) return null
  return { name: m[1], attrs: m[2] ?? "" }
}

function getAttr(attrs: string, key: string): string | undefined {
  const r = new RegExp(`${key}\\s*=\\s*"([^"]+)"`)
  const m = r.exec(attrs)
  return m ? m[1] : undefined
}

function parseToolCallForHover(serialized: string): {
  args: { name: string, mediaType?: string, text: string }[],
  results: { mediaType?: string, text: string }[],
} {
  const args: { name: string, mediaType?: string, text: string }[] = []
  const results: { mediaType?: string, text: string }[] = []

  for (const el of elementsUnder(serialized, "arguments")) {
    const t = parseTag(el)
    if (!t) continue
    const name = t.name
    const mediaType = getAttr(t.attrs, "contentMediaType")
    const text = unwrap(el, name)
    args.push({ name, mediaType, text })
  }

  for (const el of elementsUnder(serialized, "results")) {
    const t = parseTag(el)
    if (!t || t.name !== 'result') continue
    const mediaType = getAttr(t.attrs, "type")
    const text = unwrap(el, "result")
    results.push({ mediaType, text })
  }

  return { args, results }
}

function toolBlockHover(
  docText: string,
  pos: Position,
  bundle: AnalysisBundle
): Hover | null {
  const absPos = positionToOffset(docText, pos)
  const blocks = bundle.toolCallBlocks ?? []
  for (const b of blocks) {
    if (absPos < b.absStart || absPos > b.absEnd) continue

    const serialized = docText.slice(b.absStart, b.absEnd)
    const parsed = parseToolCallForHover(serialized)

    const parts: string[] = []

    const args = parsed.args.filter(a => isDisplayableMedia(a.mediaType))
    for (const a of args) {
      const header = a.mediaType ? `${a.name} (${a.mediaType})` : a.name
      const { body, lang } = prettyBodyFor(a.text, a.mediaType)
      parts.push(`## ${header}\n\n${codeFenceLang(body, lang)}`)
    }

    parts.push("---")

    const results = parsed.results.filter(r => isDisplayableMedia(r.mediaType))
    for (const r of results) {
      const header = r.mediaType ? `result (${r.mediaType})` : `result`
      const { body, lang } = prettyBodyFor(r.text, r.mediaType)
      parts.push(`## ${header}\n\n${codeFenceLang(body, lang)}`)
    }

    const value = parts.join("\n\n")
    return {
      contents: { kind: MarkupKind.Markdown, value },
      range: LspRange.create(offsetToPosition(docText, b.absStart), offsetToPosition(docText, b.absEnd))
    }
  }
  return null
}

function inlineAttachmentHover(
  docText: string,
  pos: Position,
  bundle: AnalysisBundle
): Hover | null {
  const absPos = positionToOffset(docText, pos)
  const blocks = bundle.inlineAttachmentBlocks ?? []
  for (const b of blocks) {
    if (absPos < b.absStart || absPos > b.absEnd) continue
    const serialized = docText.slice(b.absStart, b.absEnd)
    try {
      const att = deserializeInlineAttachment(serialized)
      const header = att.mimetype ? `content (${att.mimetype})` : `content`
      const parts: string[] = []
      parts.push(`## command\n\n${codeFence(att.command)}`)
      parts.push(`---`)
      if (isDisplayableMedia(att.mimetype)) {
        const { body, lang } = prettyBodyFor(att.content, att.mimetype, false )
        parts.push(`## ${header}\n\n${codeFenceLang(body, lang)}`)
      } else {
        parts.push(`## ${header}\n\n(not previewable)`)        
      }
      const value = parts.join("\n\n")
      return {
        contents: { kind: MarkupKind.Markdown, value },
        range: LspRange.create(
          offsetToPosition(docText, b.absStart),
          offsetToPosition(docText, b.absEnd)
        )
      }
    } catch {
      // not a valid inline attachment; ignore
    }
  }
  return null
}

async function listGlobMatches(
  pattern: string,
  cwd: string | undefined,
  limit: number
): Promise<{ matches: string[], truncated: boolean, total: number }> {
  const matches: string[] = []
  let truncated = false
  let total = 0
  try {
    const glob = new Bun.Glob(pattern)
    if (cwd) {
      for await (const p of glob.scan({ cwd })) {
        total++
        if (matches.length < limit) matches.push(p)
        else truncated = true
      }
    } else {
      for await (const p of glob.scan()) {
        total++
        if (matches.length < limit) matches.push(p)
        else truncated = true
      }
    }
  } catch {
    // ignore glob errors
  }
  return { matches, truncated, total }
}
