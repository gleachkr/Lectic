import type { Hover, Position } from "vscode-languageserver"
import { MarkupKind, Range as LspRange } from "vscode-languageserver/node"
import { directiveAtPosition } from "./directives"
import { parseReferences, nodeRaw } from "../parsing/markdown"
import { findUrlRangeInNodeRaw } from "./linkTargets"
import { positionToOffset, offsetToPosition } from "./positions"
import { mergedHeaderSpecForDoc } from "../parsing/parse"
import { isLecticHeaderSpec } from "../types/lectic"
import { buildMacroIndex } from "./macroIndex"
import { normalizeUrl, readHeadPreview, pathExists, hasGlobChars } from "./pathUtils"
import { stat } from "fs/promises"

export async function computeHover(
  docText: string,
  pos: Position,
  docDir: string | undefined
): Promise<Hover | null> {
  // 1) Directive hover (and macro name hover)
  const dctx = directiveAtPosition(docText, pos)
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

  // 2) Link hover: small preview for local text files
  const hrefHover = await linkHover(docText, pos, docDir)
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
  docDir: string | undefined
): Promise<Hover | null> {
  const refs = parseReferences(docText)
  const absPos = positionToOffset(docText, pos)

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

    if (absPos < innerStartOff || absPos > innerEndOff) continue

    const url = docText.slice(innerStartOff, innerEndOff)
    const norm = normalizeUrl(url, docDir)

    const range = LspRange.create(
      offsetToPosition(docText, innerStartOff),
      offsetToPosition(docText, innerEndOff)
    )
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
  return null
}

function code(s: string) { return "`" + s.replace(/`/g, "\u200b`") + "`" }

function codeFence(s: string): string {
  // Avoid breaking the fence if the content contains ```
  const safe = s.replace(/```/g, "``\u200b`")
  return "```\n" + safe + "\n```"
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
