import { pathToFileURL } from "url"

import { resolveConfigChain } from "../utils/configDiscovery"
import type { Range, Location } from "vscode-languageserver"
import { parseYaml, itemsOf, scalarValue, nodeAbsRange, getPair } from "./utils/yamlAst"
import { isObjectRecord } from "../types/guards"

// Types for safe, narrow shapes
export type InterlocutorNameEntry = { name: string, range: Range }
export type MacroNameEntry = { name: string, range: Range }
export type KitNameEntry = { name: string, range: Range }

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
  const inter = new Map<string, { uri: string, range: Range }[]>()
  const mac = new Map<string, { uri: string, range: Range }[]>()
  const kit = new Map<string, { uri: string, range: Range }[]>()

  const addEntries = (
    uri: string,
    entries: {
      interlocutors: InterlocutorNameEntry[],
      macros: MacroNameEntry[],
      kits: KitNameEntry[]
    }
  ) => {
    for (const e of entries.interlocutors) {
      const key = e.name.toLowerCase()
      const existing = inter.get(key) ?? []
      inter.set(key, [{ uri, range: e.range }, ...existing])
    }

    for (const e of entries.macros) {
      const key = e.name.toLowerCase()
      const existing = mac.get(key) ?? []
      mac.set(key, [{ uri, range: e.range }, ...existing])
    }

    for (const e of entries.kits) {
      const key = e.name.toLowerCase()
      const existing = kit.get(key) ?? []
      kit.set(key, [{ uri, range: e.range }, ...existing])
    }
  }

  const chain = await resolveConfigChain({
    includeSystem: true,
    workspaceStartDir: docDir,
    document: localHeader
      ? {
          yaml: localHeader.text,
          dir: docDir,
        }
      : undefined,
  })

  for (const source of chain.sources) {
    const uri = source.path
      ? pathToFileURL(source.path).href
      : localHeader?.uri

    if (!uri) continue
    addEntries(uri, extractNamesFromConfigYaml(source.text))
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
