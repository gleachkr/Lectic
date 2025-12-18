import { join } from "path"
import { pathToFileURL } from "url"
import { lecticConfigDir } from "../utils/xdg"
import type { Range, Location } from "vscode-languageserver"
import { parseYaml, itemsOf, scalarValue, nodeAbsRange, getPair } from "./utils/yamlAst"
import { isObjectRecord } from "../types/guards"

// Types for safe, narrow shapes
export type InterlocutorNameEntry = { name: string, range: Range }
export type MacroNameEntry = { name: string, range: Range }
export type KitNameEntry = { name: string, range: Range }

export type ConfigSource = {
  uri: string,
  text: string,
}

export type DefinitionIndex = {
  // Effective definitions by precedence (system < workspace < local)
  interlocutors: Map<string, { uri: string, range: Range }[]>,
  macros: Map<string, { uri: string, range: Range }[]>,
}


function extractNamesFromConfigYaml(text: string): {
  interlocutors: InterlocutorNameEntry[],
  macros: MacroNameEntry[],
  kits: KitNameEntry[]
} {
  const doc = parseYaml(text)
  const root = (doc as unknown as { contents?: unknown }).contents
  const inters: InterlocutorNameEntry[] = []
  const macs: MacroNameEntry[] = []
  const kits: KitNameEntry[] = []

  const singlePair = getPair(root, 'interlocutor')
  const single = singlePair?.value
  if (isObjectRecord(single)) {
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
    if (!isObjectRecord(it)) continue
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
    if (!isObjectRecord(m)) continue
    const namePair = getPair(m, 'name')
    const nv = namePair?.value
    const nameStr = scalarValue(nv)
    if (typeof nameStr === 'string') {
      const r = nodeAbsRange(text, nv, 0)
      if (r) macs.push({ name: nameStr, range: r })
    }
  }

  const kitsPair = getPair(root, 'kits')
  const kitItems = itemsOf(kitsPair?.value)
  for (const k of kitItems) {
    if (!isObjectRecord(k)) continue
    const namePair = getPair(k, 'name')
    const nv = namePair?.value
    const nameStr = scalarValue(nv)
    if (typeof nameStr === 'string') {
      const r = nodeAbsRange(text, nv, 0)
      if (r) kits.push({ name: nameStr, range: r })
    }
  }

  return { interlocutors: inters, macros: macs, kits: kits }
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
  getInterlocutors(name: string): Location[],
  getMacro(name: string): Location | null,
  getMacros(name: string): Location[],
  getKit(name: string): Location | null,
  getKits(name: string): Location[],
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
  // We store them in an array, local first.
  const inter = new Map<string, { uri: string, range: Range }[]>()
  const mac = new Map<string, { uri: string, range: Range }[]>()
  const kit = new Map<string, { uri: string, range: Range }[]>()

  const addEntries = (
    src: ConfigSource,
    entries: {
      interlocutors: InterlocutorNameEntry[],
      macros: MacroNameEntry[],
      kits: KitNameEntry[]
    },
    atStart: boolean = false
  ) => {
    for (const e of entries.interlocutors) {
      const key = e.name.toLowerCase()
      const existing = inter.get(key) ?? []
      if (atStart) {
        inter.set(key, [{ uri: src.uri, range: e.range }, ...existing])
      } else {
        inter.set(key, [...existing, { uri: src.uri, range: e.range }])
      }
    }
    for (const e of entries.macros) {
      const key = e.name.toLowerCase()
      const existing = mac.get(key) ?? []
      if (atStart) {
        mac.set(key, [{ uri: src.uri, range: e.range }, ...existing])
      } else {
        mac.set(key, [...existing, { uri: src.uri, range: e.range }])
      }
    }
    for (const e of entries.kits) {
      const key = e.name.toLowerCase()
      const existing = kit.get(key) ?? []
      if (atStart) {
        kit.set(key, [{ uri: src.uri, range: e.range }, ...existing])
      } else {
        kit.set(key, [...existing, { uri: src.uri, range: e.range }])
      }
    }
  }

  // Precedence: system < workspace < local
  // So we add them in reverse order of precedence if we want local first,
  // OR we add them in order and use unshift/atStart.
  
  // Actually, sources are [system, workspace].
  // If we add system then workspace then localHeader (using unshift),
  // we get [localHeader, workspace, system].
  
  if (system) {
    addEntries(system, extractNamesFromConfigYaml(system.text), true)
  }
  if (workspace) {
    addEntries(workspace, extractNamesFromConfigYaml(workspace.text), true)
  }
  if (localHeader) {
    addEntries(localHeader, extractNamesFromConfigYaml(localHeader.text), true)
  }

  const getInterlocutor = (name: string): Location | null => {
    const m = inter.get(name.toLowerCase())
    return m && m.length > 0 ? { uri: m[0].uri, range: m[0].range } : null
  }
  const getInterlocutors = (name: string): Location[] => {
    const m = inter.get(name.toLowerCase())
    return m ? m.map(x => ({ uri: x.uri, range: x.range })) : []
  }
  const getMacro = (name: string): Location | null => {
    const m = mac.get(name.toLowerCase())
    return m && m.length > 0 ? { uri: m[0].uri, range: m[0].range } : null
  }
  const getMacros = (name: string): Location[] => {
    const m = mac.get(name.toLowerCase())
    return m ? m.map(x => ({ uri: x.uri, range: x.range })) : []
  }
  const getKit = (name: string): Location | null => {
    const m = kit.get(name.toLowerCase())
    return m && m.length > 0 ? { uri: m[0].uri, range: m[0].range } : null
  }
  const getKits = (name: string): Location[] => {
    const m = kit.get(name.toLowerCase())
    return m ? m.map(x => ({ uri: x.uri, range: x.range })) : []
  }

  return {
    getInterlocutor,
    getInterlocutors,
    getMacro,
    getMacros,
    getKit,
    getKits
  }
}
