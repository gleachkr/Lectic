import type { FoldingRange as LspFoldingRange } from "vscode-languageserver"
import { FoldingRangeKind } from "vscode-languageserver/node"
import {
  defaultInlineAttachmentIcon,
} from "../types/inlineAttachment"

// ── Fast text-based scanner ─────────────────────────────────────────
// Computes folding ranges without building a full remark AST.
// Matches opening tags at column 0 preceded by a blank line (or start
// of input), skipping fenced code blocks and HTML comments.

const OPENING_TAGS = ["<tool-call", "<inline-attachment", "<thought-block"] as const
const CLOSING_TAGS: Record<string, string> = {
  "<tool-call": "</tool-call>",
  "<inline-attachment": "</inline-attachment>",
  "<thought-block": "</thought-block>",
}

// Matches a fenced code block opening: 0-3 spaces then 3+ backticks or tildes
const fenceOpenRe = /^( {0,3})(`{3,}|~{3,})/

function matchFenceOpen(line: string): { char: string; len: number } | null {
  const m = fenceOpenRe.exec(line)
  if (!m) return null
  // Backtick fences must not contain backticks in their info string
  const fenceChar = m[2][0]
  if (fenceChar === '`' && line.indexOf('`', m[1].length + m[2].length) !== -1) return null
  return { char: fenceChar, len: m[2].length }
}

function matchFenceClose(line: string, fence: { char: string; len: number }): boolean {
  // Closing fence: 0-3 spaces, then at least `fence.len` of the same char, then only spaces
  const m = fenceOpenRe.exec(line)
  if (!m) return false
  return m[2][0] === fence.char && m[2].length >= fence.len && line.trimEnd() === m[0]
}

export function buildFoldingRangesFromText(docText: string): LspFoldingRange[] {
  const lines = docText.split("\n")
  const out: LspFoldingRange[] = []

  let fence: { char: string; len: number } | null = null // non-null when inside a fenced code block
  let inComment = false // true when inside an HTML comment
  let prevBlank = true  // treat start-of-input as preceded by blank line

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]

    // ── Inside HTML comment ──
    if (inComment) {
      if (line.indexOf("-->") !== -1) inComment = false
      prevBlank = false
      continue
    }

    // ── Inside fenced code block ──
    if (fence) {
      if (matchFenceClose(line, fence)) fence = null
      prevBlank = false
      continue
    }

    // ── Normal state ──

    // Check for fence opening
    const fenceMatch = matchFenceOpen(line)
    if (fenceMatch) {
      fence = fenceMatch
      prevBlank = false
      continue
    }

    // Check for HTML comment opening (may open and close on same line)
    const commentStart = line.indexOf("<!--")
    if (commentStart !== -1) {
      if (line.indexOf("-->", commentStart + 4) === -1) {
        inComment = true
      }
      prevBlank = false
      continue
    }

    // Check for foldable opening tags (only when preceded by blank line)
    if (prevBlank) {
      for (const tag of OPENING_TAGS) {
        if (line.startsWith(tag)) {
          const closeTag = CLOSING_TAGS[tag]
          const endLine = scanForClose(lines, i + 1, closeTag)
          if (endLine > i) {
            const raw = lines.slice(i, endLine + 1).join("\n")
            out.push({
              startLine: i,
              endLine,
              kind: FoldingRangeKind.Region,
              collapsedText: getCollapsedText(raw),
            })
          }
          break
        }
      }
    }

    prevBlank = line.trim() === ""
  }

  return out
}

// Scan forward from `start` looking for a line containing `closeTag`.
// Respects fenced code blocks and HTML comments (won't match inside them).
function scanForClose(lines: string[], start: number, closeTag: string): number {
  let fence: { char: string; len: number } | null = null
  let inComment = false

  for (let i = start; i < lines.length; i++) {
    const line = lines[i]

    if (inComment) {
      if (line.indexOf("-->") !== -1) inComment = false
      continue
    }

    if (fence) {
      if (matchFenceClose(line, fence)) fence = null
      continue
    }

    const fenceMatch = matchFenceOpen(line)
    if (fenceMatch) {
      fence = fenceMatch
      continue
    }

    const commentStart = line.indexOf("<!--")
    if (commentStart !== -1) {
      if (line.indexOf("-->", commentStart + 4) === -1) {
        inComment = true
      }
      continue
    }

    if (line.trimStart().startsWith(closeTag)) {
      return i
    }
  }

  return -1
}

function getAttribute(line: string, name: string): string | undefined {
  const match = new RegExp(`${name}="([^"]*)"`).exec(line)
  return match?.[1]
}

function getCollapsedText(raw: string): string {
  const useNerdFont = process.env["NERD_FONT"] === "1"
  const line = raw.split("\n")[0].trim()

  if (line.startsWith("<tool-call")) {
    const name = getAttribute(line, "with") ?? "tool"
    const kind = getAttribute(line, "kind") ?? ""
    const icon = getAttribute(line, "icon") ?? ""

    if (useNerdFont) {
      return `${icon} ${name}`
    }

    const label = kind ? `${kind} tool` : "tool"
    return `[${label}: ${name}]`
  }

  if (line.startsWith("<inline-attachment")) {
    const rawKind = getAttribute(line, "kind") ?? "attach"
    const kind = rawKind === "cmd" ? "attach" : rawKind
    const fallbackIcon = defaultInlineAttachmentIcon(kind)
    const icon = getAttribute(line, "icon") ?? fallbackIcon
    const name = getAttribute(line, "name")

    if (useNerdFont) {
      const label = name ?? kind
      return `${icon} ${label}`
    }

    if (name) {
      return `[${kind}: ${name}]`
    }

    return `[${kind}]`
  }

  if (line.startsWith("<thought-block")) {
    const provider = getAttribute(line, "provider")
    const kind = getAttribute(line, "provider-kind")
    const label = [provider, kind].filter(Boolean).join(" ")

    if (useNerdFont) {
      return label ? ` ${label}` : " thought"
    }

    return label ? `[thought: ${label}]` : "[thought]"
  }

  return "..."
}

export function buildFoldingRanges(docText: string): LspFoldingRange[] {
  return buildFoldingRangesFromText(docText)
}
