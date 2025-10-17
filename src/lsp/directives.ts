import type { Position as LspPosition, Range as LspRange } from "vscode-languageserver"
import { Position as LspPos, Range as LspRan } from "vscode-languageserver/node"
import { getBody } from "../parsing/parse"
import { parseDirectives, nodeRaw } from "../parsing/markdown"
import { offsetToPosition, positionToOffset } from "./positions"
import type { AnalysisBundle } from "./analysisTypes"

// Helpers shared across LSP modules
export function findSingleColonStart(lineText: string, ch: number): number | null {
  let idx = ch - 1
  while (idx >= 0 && lineText[idx] !== ":") idx--
  if (idx < 0 || lineText[idx] !== ":") return null
  let left = idx
  while (left - 1 >= 0 && lineText[left - 1] === ":") left--
  let right = idx
  while (right + 1 < lineText.length && lineText[right + 1] === ":") right++
  const runLen = right - left + 1
  if (runLen !== 1) return null
  return idx
}

export function computeReplaceRange(
  line: number,
  colonCol: number,
  curCol: number
): LspRange {
  return LspRan.create(LspPos.create(line, colonCol), LspPos.create(line, curCol))
}


/**
 * DirectiveContext describes the directive (e.g. :ask[...]) that
 * contains the current cursor position, along with precise ranges
 * and convenient precomputed text slices.
 */
export type DirectiveContext = {
  /**
   * Normalized directive key (lowercase), e.g. "ask", "aside",
   * "macro", "cmd", "reset". Empty string when unknown.
   */
  key: string
  /**
   * True when the cursor is between the directive's brackets, i.e.
   * inside the [...]. Used to enable bracket‑aware completion.
   */
  insideBrackets: boolean
  /**
   * Full text inside the brackets at the time of the query. This is
   * exclusive of the [ and ].
   */
  innerText: string
  /**
   * The portion of innerText that lies before the cursor. This is
   * useful for prefix filtering without recomputing offsets.
   */
  innerPrefix: string
  /**
   * LSP position of the first character inside the brackets (just
   * after '[').
   */
  innerStart: LspPosition
  /**
   * LSP position of the last character inside the brackets (just
   * before ']').
   */
  innerEnd: LspPosition
  /**
   * LSP position of the directive start (spans the entire node,
   * including the leading ':' and name).
   */
  nodeStart: LspPosition
  /**
   * LSP position of the directive end (end of the node).
   */
  nodeEnd: LspPosition
}

export function directiveAtPosition(
  docText: string,
  pos: LspPosition
): DirectiveContext | null {
  // Parse directives from the body only; compute header end line to
  // convert node-local positions to absolute LSP positions.
  const body = getBody(docText)
  const bodyDirectives = parseDirectives(body)

  // Map body offsets to absolute document offsets
  const prefixLen = docText.length - body.length
  const posAbsOff = positionToOffset(docText, pos)

  // Consider the directive whose range contains the cursor position.
  for (const d of bodyDirectives) {
    const s = d.position?.start
    const e = d.position?.end
    if (!s || !e || s.offset == null || e.offset == null) continue

    const absStartOff = prefixLen + s.offset
    const absEndOff = prefixLen + e.offset

    const within = posAbsOff >= absStartOff && posAbsOff <= absEndOff
    if (!within) continue

    const key = d.name ? String(d.name).toLowerCase() : ""

    // Prefer computing inner range by locating the brackets in the raw text.
    // This works even when the directive has empty content (no children).
    const raw = nodeRaw(d, body)
    const leftIdx = raw.indexOf("[")
    const rightIdx = raw.lastIndexOf("]")

    const innerStartOff = s.offset + leftIdx + 1
    const innerEndOff = s.offset + rightIdx
    const absInnerStartOff = prefixLen + innerStartOff
    const absInnerEndOff = prefixLen + innerEndOff

    const innerStart = offsetToPosition(docText, absInnerStartOff)
    const innerEnd = offsetToPosition(docText, absInnerEndOff)

    const insideBrackets = posAbsOff >= absInnerStartOff && posAbsOff <= absInnerEndOff

    const nodeStart = offsetToPosition(docText, absStartOff)
    const nodeEnd = offsetToPosition(docText, absEndOff)

    const innerText = docText.slice(absInnerStartOff, absInnerEndOff)
    const typedLen = Math.max(0, Math.min(innerText.length, posAbsOff - absInnerStartOff))
    const innerPrefix = innerText.slice(0, typedLen)

    return {
      key,
      insideBrackets,
      innerText,
      innerPrefix,
      innerStart,
      innerEnd,
      nodeStart,
      nodeEnd,
    }
  }

  return null
}

export function directiveAtPositionFromBundle(
  docText: string,
  pos: LspPosition,
  bundle: AnalysisBundle
): DirectiveContext | null {
  const absPos = positionToOffset(docText, pos)
  for (const d of bundle.directives) {
    if (absPos < d.absStart || absPos > d.absEnd) continue
    const innerStart = offsetToPosition(docText, d.innerStart)
    const innerEnd = offsetToPosition(docText, d.innerEnd)
    const nodeStart = offsetToPosition(docText, d.absStart)
    const nodeEnd = offsetToPosition(docText, d.absEnd)
    const innerText = docText.slice(d.innerStart, d.innerEnd)
    const typedLen = Math.max(0, Math.min(innerText.length, absPos - d.innerStart))
    const innerPrefix = innerText.slice(0, typedLen)
    const insideBrackets = absPos >= d.innerStart && absPos <= d.innerEnd
    return {
      key: d.key,
      insideBrackets,
      innerText,
      innerPrefix,
      innerStart,
      innerEnd,
      nodeStart,
      nodeEnd,
    }
  }
  return null
}
