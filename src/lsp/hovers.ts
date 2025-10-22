import type { Hover, Position } from "vscode-languageserver"
import { MarkupKind, Range as LspRange } from "vscode-languageserver/node"
import { directiveAtPositionFromBundle } from "./directives"
import { linkTargetAtPositionFromBundle } from "./linkTargets"
import { offsetToPosition, positionToOffset } from "./positions"
import { mergedHeaderSpecForDoc } from "../parsing/parse"
import { isLecticHeaderSpec } from "../types/lectic"
import { buildMacroIndex } from "./macroIndex"
import { normalizeUrl, readHeadPreview, pathExists, hasGlobChars } from "./pathUtils"
import { stat } from "fs/promises"
import type { AnalysisBundle } from "./analysisTypes"
import { unescapeTags, extractElements, unwrap } from "../parsing/xml" 
import { deserializeInlineAttachment } from "../types/inlineAttachment"

export async function computeHover(
  docText: string,
  pos: Position,
  docDir: string | undefined,
  bundle: AnalysisBundle
): Promise<Hover | null> {
  // 1) Directive hover (and macro name hover)
  const dctx = directiveAtPositionFromBundle(docText, pos, bundle)
  if (dctx && dctx.key) {
    // Macro name hover inside brackets shows expansion preview
    if (dctx.key === "macro" && dctx.insideBrackets) {
      const name = dctx.innerText.trim()
      if (name.length > 0) {
        const spec = await mergedHeaderSpecForDoc(docText, docDir)
        if (isLecticHeaderSpec(spec)) {
          const macros = buildMacroIndex(spec)
          const found = macros.find(m => m.name === name)
          if (found) {
            const snippet = found.expansion
              .slice(0, 500)
              .replace(/`/g, "\u200b`")
            return {
              contents: {
                kind: MarkupKind.Markdown,
                value: `macro ${code(name)}\n\n${code(snippet)}`
              },
              range: LspRange.create(dctx.innerStart, dctx.innerEnd)
            }
          }
        }
      }
    }
    const info = directiveInfo(dctx.key)
    if (info) {
      return {
        contents: {
          kind: MarkupKind.Markdown,
          value: `:${info.key} — ${info.title}\n\n${info.body}`
        },
        range: LspRange.create(dctx.nodeStart, dctx.nodeEnd)
      }
    }
  }

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

function directiveInfo(key: string): { key: string, title: string, body: string } | null {
  const map: Record<string, { title: string, body: string }> = {
    cmd: {
      title: "run a shell command and insert stdout",
      body: "Execute a command using the Bun shell and inline its stdout into the message."
    },
    reset: {
      title: "clear prior conversation context for this turn",
      body: "Start this turn fresh. Previous history is not sent to the model."
    },
    ask: {
      title: "switch interlocutor for subsequent turns",
      body: "Permanently switch the active interlocutor until changed again."
    },
    aside: {
      title: "address one interlocutor for a single turn",
      body: "Temporarily switch interlocutor for just this user message."
    },
    macro: {
      title: "expand a named macro",
      body: "Insert the expansion text of a macro defined in config or header."
    }
  }
  const entry = map[key]
  return entry ? { key, ...entry } : null
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

async function linkPreviewWith(norm: ReturnType<typeof normalizeUrl>, range: any, docDir: string | undefined): Promise<Hover | null> {
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

function code(s: string) { return "`" + s.replace(/`/g, "\u200b`") + "`" }

function codeFence(s: string): string {
  // Avoid breaking the fence if the content contains ```
  const safe = s.replace(/```/g, "``\u200b`")
  return "```\n" + safe + "\n```"
}

function codeFenceLang(s: string, lang: string | null | undefined): string {
  const safe = s.replace(/```/g, "``\u200b`")
  const header = lang && lang.length > 0 ? "```" + lang : "```"
  return header + "\n" + safe + "\n```"
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

function prettyBodyFor(raw: string, mediaType? : string, escape : boolean = true): { body: string, lang: string | null } {
  // raw here is serialized text with line markers and <│ escapes.
  // We must unescape before pretty printing.
  let lang = langFor(mediaType)
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
  const body = escape ? unescapeTags(raw) : raw
  return { body, lang }
}

function elementsUnder(serialized: string, parentTag: string): string[] {
  const open = `<${parentTag}>`
  const close = `</${parentTag}>`
  const start = serialized.indexOf(open)
  const end = start >= 0 ? serialized.indexOf(close, start + open.length) : -1
  if (start < 0 || end <= start) return []
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
