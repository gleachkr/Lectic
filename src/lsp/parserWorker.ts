/// <reference lib="webworker" />
import { remark } from "remark"
import remarkDirective from "remark-directive"
import { buildDiagnostics } from "./diagnostics"
import { buildFoldingRangesFromAst } from "./folding"
import { getBody } from "../parsing/parse"
import { directivesFromAst, referencesFromAst, nodeRaw, parseBlocks } from "../parsing/markdown"
import { findUrlRangeInNodeRaw } from "./linkTargets"
import type {
  FoldResult,
  DiagnosticsResult,
  WorkerMessage,
  BundleResult,
  AnalysisBundle,
  DirectiveSpan,
  LinkSpan,
  BlockSpan,
} from "./analysisTypes"

// Bun's Worker uses the web worker API. We listen for messages and
// post results back to the parent. We do not retain any global state.

function buildBundleFromAst(ast: any, docText: string, uri: string, version: number): AnalysisBundle {
  const directives: DirectiveSpan[] = []
  const links: LinkSpan[] = []
  const blocks: BlockSpan[] = []

  // Compute header offset using body extraction
  const body = getBody(docText)
  const headerOffset = docText.length - body.length

  // User-chunk directives (skip assistant containers)
  for (const d of directivesFromAst(ast) as any[]) {
    const s = d.position?.start?.offset
    const e = d.position?.end?.offset
    if (typeof s !== 'number' || typeof e !== 'number') continue
    const raw = nodeRaw(d, docText)
    const l = raw.indexOf("[")
    const r = raw.lastIndexOf("]")
    if (l < 0 || r < 0 || r <= l) continue
    const innerStart = s + l + 1
    const innerEnd = s + r
    directives.push({
      key: typeof d.name === 'string' ? d.name.toLowerCase() : '',
      absStart: s,
      absEnd: e,
      innerStart,
      innerEnd,
    })
  }

  // Links/images in user chunks
  for (const n of referencesFromAst(ast) as any[]) {
    const s = n.position?.start?.offset
    const e = n.position?.end?.offset
    if (typeof s !== 'number' || typeof e !== 'number') continue
    const raw = nodeRaw(n, docText)
    const rng = findUrlRangeInNodeRaw(raw, s, String(n.url ?? ''))
    if (!rng) continue
    const [us, ue] = rng
    links.push({ absStart: s, absEnd: e, urlStart: us, urlEnd: ue })
  }

  // Assistant containers and user spans interleaved; bound to body only
  type Asst = { name: string, s: number, e: number }
  const assistants: Asst[] = []
  for (const node of (parseBlocks(body) as any[])) {
    if (node.type === 'containerDirective' && typeof node.name === 'string') {
      const s = node.position?.start?.offset
      const e = node.position?.end?.offset
      if (typeof s === 'number' && typeof e === 'number') {
        assistants.push({ name: String(node.name), s: headerOffset + s, e: headerOffset + e })
      }
    }
  }
  assistants.sort((a, b) => a.s - b.s)

  let cursor = headerOffset
  for (const a of assistants) {
    if (a.s > cursor) {
      blocks.push({ kind: 'user', absStart: cursor, absEnd: a.s })
    }
    blocks.push({ kind: 'assistant', absStart: a.s, absEnd: a.e, name: a.name })
    cursor = a.e
  }
  if (cursor < docText.length) blocks.push({ kind: 'user', absStart: cursor, absEnd: docText.length })

  return { uri, version, headerOffset, directives, links, blocks }
}

self.addEventListener("message", async (ev: MessageEvent<WorkerMessage>) => {
  const msg = ev.data
  if (msg.type !== "analyze") return
  try {
    // Single parse shared by folding, diagnostics, and bundle
    const ast = remark().use(remarkDirective).parse(msg.text)

    // 1) Folds first for UX
    try {
      const folding = buildFoldingRangesFromAst(ast, msg.text)
      const foldMsg: FoldResult = {
        type: "fold",
        uri: msg.uri,
        version: msg.version,
        folding,
      }
      self.postMessage(foldMsg)
    } catch {
      const foldMsg: FoldResult = {
        type: "fold",
        uri: msg.uri,
        version: msg.version,
        folding: [],
      }
      self.postMessage(foldMsg)
    }

    // 2) Bundle second
    try {
      const bundle = buildBundleFromAst(ast, msg.text, msg.uri, msg.version)
      const bundleMsg: BundleResult = {
        type: "bundle",
        uri: msg.uri,
        version: msg.version,
        bundle,
      }
      self.postMessage(bundleMsg)
    } catch {
      // Ignore bundle errors; callers will wait for next analysis
    }

    // 3) Diagnostics
    try {
      const diagnostics = await buildDiagnostics(ast, msg.text, msg.docDir)
      const diagMsg: DiagnosticsResult = {
        type: "diagnostics",
        uri: msg.uri,
        version: msg.version,
        diagnostics,
      }
      self.postMessage(diagMsg)
    } catch {
      const diagMsg: DiagnosticsResult = {
        type: "diagnostics",
        uri: msg.uri,
        version: msg.version,
        diagnostics: [],
      }
      self.postMessage(diagMsg)
    }
  } catch {
    // Total parse failure: send empty fold and empty diagnostics
    const foldMsg: FoldResult = {
      type: "fold",
      uri: msg.uri,
      version: msg.version,
      folding: [],
    }
    self.postMessage(foldMsg)
    const diagMsg: DiagnosticsResult = {
      type: "diagnostics",
      uri: msg.uri,
      version: msg.version,
      diagnostics: [],
    }
    self.postMessage(diagMsg)
  }
})
