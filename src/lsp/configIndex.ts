import { join } from "path"
import { pathToFileURL } from "url"
import { lecticConfigDir } from "../utils/xdg"
import type { Range, Location } from "vscode-languageserver"
import { parseYaml, itemsOf, scalarValue, nodeAbsRange, isObj, getPair } from "./utils/yamlAst"

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


function extractNamesFromConfigYaml(text: string): {
  interlocutors: InterlocutorNameEntry[],
  macros: MacroNameEntry[]
} {
  const doc = parseYaml(text)
  const root = (doc as unknown as { contents?: unknown }).contents
  const inters: InterlocutorNameEntry[] = []
  const macs: MacroNameEntry[] = []

  const singlePair = getPair(root, 'interlocutor')
  const single = singlePair?.value
  if (isObj(single)) {
    const namePair = getPair(single, 'name')
    const nameVal = namePair?.value
    const nameStr = scalarValue(nameVal)
    if (typeof nameStr === 'string') {
      const r = nodeAbsRange(text, nameVal, 0)
      if (r) inters.push({ name: nameStr, range: r })
    }
  }

  const listPair = getPair(root, 'interlocutors')
  const listItems = itemsOf(listPair?.value)
  for (const it of listItems) {
    if (!isObj(it)) continue
    const namePair = getPair(it, 'name')
    const nv = namePair?.value
    const nameStr = scalarValue(nv)
    if (typeof nameStr === 'string') {
      const r = nodeAbsRange(text, nv, 0)
      if (r) inters.push({ name: nameStr, range: r })
    }
  }

  const macrosPair = getPair(root, 'macros')
  const macroItems = itemsOf(macrosPair?.value)
  for (const m of macroItems) {
    if (!isObj(m)) continue
    const namePair = getPair(m, 'name')
    const nv = namePair?.value
    const nameStr = scalarValue(nv)
    if (typeof nameStr === 'string') {
      const r = nodeAbsRange(text, nv, 0)
      if (r) macs.push({ name: nameStr, range: r })
    }
  }

  return { interlocutors: inters, macros: macs }
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
