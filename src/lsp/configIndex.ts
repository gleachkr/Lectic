import { join } from "path"
import { pathToFileURL } from "url"
import { lecticConfigDir } from "../utils/xdg"
import * as YAML from "yaml"
import type { Range, Position, Location } from "vscode-languageserver"
import { Range as LspRange, Position as LspPosition } from "vscode-languageserver/node"

// Types for safe, narrow shapes
export type InterlocutorNameEntry = { name: string, range: Range }
export type MacroNameEntry = { name: string, range: Range }

export type ConfigSource = {
  uri: string,
  text: string,
}

export type DefinitionIndex = {
  // Effective definitions by precedence (system < workspace < local)
  interlocutors: Map<string, { uri: string, range: Range }>,
  macros: Map<string, { uri: string, range: Range }>,
}

function offsetToPosition(text: string, offset: number): Position {
  let line = 0
  let col = 0
  for (let i = 0; i < offset && i < text.length; i++) {
    const ch = text.charCodeAt(i)
    if (ch === 10) { line++; col = 0 }
    else if (ch === 13) { if (i + 1 < text.length && text.charCodeAt(i+1)===10) i++; line++; col=0 }
    else col++
  }
  return LspPosition.create(line, col)
}

// Basic YAML map item access without any
function mapGetPair(map: any, key: string): { key: any, value: any } | undefined {
  const items: any[] = (map && typeof map === 'object' && Array.isArray(map.items))
    ? map.items : []
  for (const it of items) {
    const k = (it?.key as any)?.value
    if (k === key) return { key: it.key, value: it.value }
  }
  return undefined
}

function nodeAbsRange(text: string, node: any, baseOffset: number): Range | null {
  const r = (node as any)?.range
  if (Array.isArray(r) && typeof r[0] === 'number' && typeof r[2] === 'number') {
    const start = baseOffset + r[0]
    const end = baseOffset + r[2]
    return LspRange.create(offsetToPosition(text, start), offsetToPosition(text, end))
  }
  const c = (node as any)?.cstNode as any
  if (c && typeof c.offset === 'number' && typeof c.end === 'number') {
    const start = baseOffset + c.offset
    const end = baseOffset + c.end
    return LspRange.create(offsetToPosition(text, start), offsetToPosition(text, end))
  }
  return null
}

function extractNamesFromConfigYaml(text: string): {
  interlocutors: InterlocutorNameEntry[],
  macros: MacroNameEntry[]
} {
  const doc = YAML.parseDocument(text, {
    keepCstNodes: true,
    keepNodeTypes: true,
    logLevel: "silent"
  } as any)
  const root: any = doc.contents
  const inters: InterlocutorNameEntry[] = []
  const macros: MacroNameEntry[] = []

  const singlePair = mapGetPair(root, 'interlocutor')
  const single = singlePair?.value
  if (single && typeof single === 'object') {
    const namePair = mapGetPair(single, 'name')
    const nameVal = namePair?.value
    const nameStr = (nameVal as any)?.value
    if (typeof nameStr === 'string') {
      const r = nodeAbsRange(text, nameVal, 0)
      if (r) inters.push({ name: nameStr, range: r })
    }
  }

  const listPair = mapGetPair(root, 'interlocutors')
  const listItems: any[] = Array.isArray(listPair?.value?.items) ? listPair!.value.items : []
  for (const it of listItems) {
    if (!it || typeof it !== 'object') continue
    const namePair = mapGetPair(it, 'name')
    const nv = namePair?.value
    const nameStr = (nv as any)?.value
    if (typeof nameStr === 'string') {
      const r = nodeAbsRange(text, nv, 0)
      if (r) inters.push({ name: nameStr, range: r })
    }
  }

  const macrosPair = mapGetPair(root, 'macros')
  const macroItems: any[] = Array.isArray(macrosPair?.value?.items) ? macrosPair!.value.items : []
  for (const m of macroItems) {
    if (!m || typeof m !== 'object') continue
    const namePair = mapGetPair(m, 'name')
    const nv = namePair?.value
    const nameStr = (nv as any)?.value
    if (typeof nameStr === 'string') {
      const r = nodeAbsRange(text, nv, 0)
      if (r) macros.push({ name: nameStr, range: r })
    }
  }

  return { interlocutors: inters, macros }
}


async function readConfigSource(path: string): Promise<ConfigSource | null> {
  try {
    const text = await Bun.file(path).text()
    const uri = pathToFileURL(path).href
    return { uri, text }
  } catch {
    return null
  }
}

export type DefinitionLookup = {
  getInterlocutor(name: string): Location | null,
  getMacro(name: string): Location | null,
}

export async function buildDefinitionIndex(
  docDir: string | undefined,
  localHeader: { uri: string, text: string } | null
): Promise<DefinitionLookup> {
  const systemPath = join(lecticConfigDir(), 'lectic.yaml')
  const system = await readConfigSource(systemPath)

  // Workspace config: match CLI and other LSP paths by reading
  // lectic.yaml from the document directory only (no upward walk).
  const workspace = docDir ? await readConfigSource(join(docDir, 'lectic.yaml')) : null

  const sources: ConfigSource[] = []
  if (system) sources.push(system)
  if (workspace) sources.push(workspace)

  // Effective maps with precedence: system < workspace < local
  const inter = new Map<string, { uri: string, range: Range }>()
  const mac = new Map<string, { uri: string, range: Range }>()

  const addEntries = (
    src: ConfigSource,
    entries: { interlocutors: InterlocutorNameEntry[], macros: MacroNameEntry[] }
  ) => {
    for (const e of entries.interlocutors) {
      const key = e.name.toLowerCase()
      inter.set(key, { uri: src.uri, range: e.range })
    }
    for (const e of entries.macros) {
      mac.set(e.name.toLowerCase(), { uri: src.uri, range: e.range })
    }
  }

  for (const src of sources) {
    addEntries(src, extractNamesFromConfigYaml(src.text))
  }

  if (localHeader) {
    // Reuse YAML extractor on the local header YAML content
    addEntries(localHeader, extractNamesFromConfigYaml(localHeader.text))
  }

  const getInterlocutor = (name: string): Location | null => {
    const m = inter.get(name.toLowerCase())
    return m ? { uri: m.uri, range: m.range } : null
  }
  const getMacro = (name: string): Location | null => {
    const m = mac.get(name.toLowerCase())
    return m ? { uri: m.uri, range: m.range } : null
  }

  return { getInterlocutor, getMacro }
}
