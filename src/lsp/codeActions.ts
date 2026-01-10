import type { CodeAction, CodeActionKind, CodeActionParams, Range, TextEdit } from "vscode-languageserver"
import { CodeActionKind as LspCodeActionKind, Range as LspRange } from "vscode-languageserver/node"
import { linkTargetAtPositionFromBundle } from "./linkTargets"
import { directiveAtPositionFromBundle } from "./directives"
import { positionToOffset, offsetToPosition } from "./positions"
import { mergedHeaderSpecForDocDetailed } from "../parsing/parse"
import { expandEnv } from "../utils/replace"
import { isLecticHeaderSpec } from "../types/lectic"
import { buildInterlocutorIndex } from "./interlocutorIndex"
import type { AnalysisBundle } from "./analysisTypes"
import { Macro, validateMacroSpec } from "../types/macro"
import { expandMacros } from "../parsing/macro"

function codeAction(kind: CodeActionKind, title: string, edits: TextEdit[], uri: string): CodeAction {
  return { title, kind, edit: { changes: { [uri]: edits } } }
}

function resolveAction(kind: CodeActionKind, title: string, data: unknown): CodeAction {
  return { title, kind, data }
}

function findLinkAtPosition(docText: string, posOff: number, bundle: AnalysisBundle): { range: Range, text: string } | null {
  const pos = offsetToPosition(docText, posOff)
  const hit = linkTargetAtPositionFromBundle(docText, pos, bundle)
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

function inferDefaultProviderFromEnv(): string | null {
  const env = typeof process !== 'undefined' ? process.env : undefined
  if (!env) return null
  if (env["ANTHROPIC_API_KEY"]) return "anthropic"
  if (env["GEMINI_API_KEY"]) return "gemini"
  if (env["OPENAI_API_KEY"]) return "openai"
  if (env["OPENROUTER_API_KEY"]) return "openrouter"
  return null
}

function headerFenceMatch(raw: string): RegExpExecArray | null {
  const re = /^---\n([\s\S]*?)\n(?:---|\.\.\.)/
  return re.exec(raw)
}

function buildMinimalHeader(provider: string | null): string {
  const lines: string[] = []
  lines.push('---')
  lines.push('interlocutor:')
  lines.push('  name: Assistant')
  lines.push('  prompt: You are a helpful assistant.')
  if (provider) {
    lines.push(`  provider: ${provider}`)
  }
  lines.push('---')
  return lines.join('\n') + '\n\n'
}

export async function computeCodeActions(
  uri: string,
  docText: string,
  params: CodeActionParams,
  docDir: string | undefined,
  bundle: AnalysisBundle
): Promise<CodeAction[] | null> {
  const out: CodeAction[] = []
  const posOff = positionToOffset(docText, params.range.start)

  // 0) Insert minimal header when missing or empty
  try {
    const match = headerFenceMatch(docText)
    const provider = inferDefaultProviderFromEnv()
    if (!match) {
      // No header present → insert at top
      const header = buildMinimalHeader(provider)
      out.push(codeAction(
        LspCodeActionKind.QuickFix,
        'Insert Lectic header',
        [{ range: LspRange.create(offsetToPosition(docText, 0), offsetToPosition(docText, 0)), newText: header }],
        uri
      ))
    } else {
      const content = match[1] ?? ''
      if (content.trim().length === 0) {
        // Replace empty header block (including fences)
        const start = match.index
        const end = match.index + match[0].length
        const header = buildMinimalHeader(provider)
        out.push(codeAction(
          LspCodeActionKind.QuickFix,
          'Replace empty header with minimal Lectic header',
          [{ range: LspRange.create(offsetToPosition(docText, start), offsetToPosition(docText, end)), newText: header }],
          uri
        ))
      }
    }
  } catch {
    // ignore
  }

  // 1) Link quick fixes
  const link = findLinkAtPosition(docText, posOff, bundle)
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

  // 2) directive-specific code actions
  try {
    const dctx = directiveAtPositionFromBundle(docText, params.range.start, bundle)
    if (dctx) {
      // a) Macro expansion
      if (
        dctx.key &&
        ![
          'ask',
          'aside',
          'cmd',
          'attach',
          'reset',
          'merge_yaml',
          'temp_merge_yaml',
        ].includes(dctx.key)
      ) {
        const specRes = await mergedHeaderSpecForDocDetailed(docText, docDir)
        if (specRes.spec && typeof specRes.spec === 'object' && 'macros' in specRes.spec) {
          const rawMacros = specRes.spec.macros
          if (Array.isArray(rawMacros)) {
             const found = rawMacros.some((m: unknown) => 
               validateMacroSpec(m) && m.name.toLowerCase() === dctx.key
             )
             if (found) {
               out.push(resolveAction(
                 LspCodeActionKind.RefactorInline,
                 `Expand macro :${dctx.key}`,
                 {
                   type: 'expand-macro',
                   uri,
                   range: LspRange.create(dctx.nodeStart, dctx.nodeEnd)
                 }
               ))
             }
          }
        }
      }

      // b) Ask/Aside correction
      if (dctx.insideBrackets && (dctx.key === 'ask' || dctx.key === 'aside')) {
        const current = dctx.innerText.trim()
        if (current.length > 0) {
          const specRes = await mergedHeaderSpecForDocDetailed(docText, docDir)
          const candidates = collectInterlocutorNames(specRes.spec)
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
    }
  } catch {
    // ignore errors
  }

  return out.length ? out : null
}

export async function resolveCodeAction(
  action: CodeAction,
  docText: string,
  docDir: string | undefined
): Promise<CodeAction> {
  const data = action.data
  if (!data || typeof data !== 'object' || data.type !== 'expand-macro') {
    return action
  }

  // Perform expansion
  const range = data.range as Range
  const startOff = positionToOffset(docText, range.start)
  const endOff = positionToOffset(docText, range.end)
  const snippet = docText.slice(startOff, endOff)

  // Retrieve macros
  const specRes = await mergedHeaderSpecForDocDetailed(docText, docDir)
  const macros: Record<string, Macro> = {}
  
  if (specRes.spec && typeof specRes.spec === 'object' && 'macros' in specRes.spec) {
    const rawMacros = specRes.spec.macros
    if (Array.isArray(rawMacros)) {
      for (const m of rawMacros) {
        if (validateMacroSpec(m)) {
          const macro = new Macro(m)
          macros[macro.name.toLowerCase()] = macro
        }
      }
    }
  }

  try {
    const expanded = await expandMacros(snippet, macros)
    action.edit = {
      changes: {
        [data.uri]: [{ range, newText: expanded }]
      }
    }
  } catch {
    // If expansion fails, we return the action as is (no edit),
    // or we could throw. The client will just see no change.
  }

  return action
}
