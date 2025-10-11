import type { CodeAction, CodeActionKind, CodeActionParams, Range, TextEdit } from "vscode-languageserver"
import { CodeActionKind as LspCodeActionKind, Range as LspRange } from "vscode-languageserver/node"
import { linkTargetAtPosition } from "./linkTargets"
import { directiveAtPosition } from "./directives"
import { positionToOffset, offsetToPosition } from "./positions"
import { mergedHeaderSpecForDoc } from "../parsing/parse"
import { expandEnv } from "../utils/replace"
import { isLecticHeaderSpec } from "../types/lectic"
import { buildInterlocutorIndex } from "./interlocutorIndex"

function codeAction(kind: CodeActionKind, title: string, edits: TextEdit[], uri: string): CodeAction {
  return { title, kind, edit: { changes: { [uri]: edits } } }
}

function findLinkAtPosition(docText: string, posOff: number): { range: Range, text: string } | null {
  const pos = offsetToPosition(docText, posOff)
  const hit = linkTargetAtPosition(docText, pos)
  if (!hit) return null
  return {
    range: LspRange.create(
      offsetToPosition(docText, hit.startOff),
      offsetToPosition(docText, hit.endOff)
    ),
    text: docText.slice(hit.startOff, hit.endOff)
  }
}

function toFixFileUrl(text: string, docDir?: string): string | null {
  const trimmed = text.trim()
  if (!trimmed.startsWith('file://')) return null
  const rest = trimmed.slice('file://'.length)
  if (rest.startsWith('/')) return null
  if (rest.startsWith('$PWD/')) return null
  const expanded = expandEnv(rest, docDir ? { PWD: docDir } : {})
  if (expanded.startsWith('/')) return null
  const cleaned = rest.replace(/^\.\//, '')
  return 'file://$PWD/' + cleaned
}

function toConvertRelativeToFilePwd(text: string): string | null {
  const trimmed = text.trim()
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed)) return null
  if (trimmed.startsWith('/')) return null
  if (trimmed.startsWith('$PWD/')) return null
  const cleaned = trimmed.replace(/^\.\//, '')
  return 'file://$PWD/' + cleaned
}

function distance(a: string, b: string): number {
  const m = a.length, n = b.length
  const dp = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0))
  for (let i = 0; i <= m; i++) dp[i][0] = i
  for (let j = 0; j <= n; j++) dp[0][j] = j
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + cost
      )
    }
  }
  return dp[m][n]
}

function collectInterlocutorNames(spec: unknown): string[] {
  if (isLecticHeaderSpec(spec)) {
    return buildInterlocutorIndex(spec).map(i => i.name)
  }
  return []
}

export async function computeCodeActions(
  uri: string,
  docText: string,
  params: CodeActionParams,
  docDir: string | undefined
): Promise<CodeAction[] | null> {
  const out: CodeAction[] = []
  const posOff = positionToOffset(docText, params.range.start)

  // 1) Link quick fixes
  const link = findLinkAtPosition(docText, posOff)
  if (link) {
    const fixed = toFixFileUrl(link.text, docDir)
    if (fixed) {
      out.push(codeAction(
        LspCodeActionKind.QuickFix,
        'Make file:// absolute via $PWD',
        [{ range: link.range, newText: fixed }],
        uri
      ))
    } else {
      const converted = toConvertRelativeToFilePwd(link.text)
      if (converted) {
        out.push(codeAction(
          LspCodeActionKind.QuickFix,
          'Convert to file://$PWD/...',
          [{ range: link.range, newText: converted }],
          uri
        ))
      }
    }
  }

  // 2) Unknown :ask/:aside closest‑match replacement
  try {
    const dctx = directiveAtPosition(docText, params.range.start)
    if (dctx && dctx.insideBrackets && (dctx.key === 'ask' || dctx.key === 'aside')) {
      const current = dctx.innerText.trim()
      if (current.length > 0) {
        const spec = await mergedHeaderSpecForDoc(docText, docDir)
        const candidates = collectInterlocutorNames(spec)
        const ranked = candidates
          .map(n => ({ n, d: distance(current, n) }))
          .filter(x => x.d <= 2)
          .sort((a, b) => a.d - b.d)
        for (const r of ranked) {
          out.push(codeAction(
            LspCodeActionKind.QuickFix,
            `Replace with ${r.n}`,
            [{ range: LspRange.create(dctx.innerStart, dctx.innerEnd), newText: r.n }],
            uri
          ))
        }
      }
    }
  } catch {
    // ignore errors
  }

  return out.length ? out : null
}
