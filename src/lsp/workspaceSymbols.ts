import type { SymbolInformation } from "vscode-languageserver"
import { SymbolKind } from "vscode-languageserver"
import { Location as LspLocation } from "vscode-languageserver/node"
import type { Range as VRange } from "vscode-languageserver"
import { readFile } from "fs/promises"
import { pathToFileURL } from "url"

import { resolveConfigChain } from "../utils/configDiscovery"
import { parseYaml, itemsOf, scalarValue, getPair, nodeAbsRange } from "./utils/yamlAst"
import { isObjectRecord } from "../types/guards"

async function symbolsFromYamlFile(filePath: string): Promise<SymbolInformation[]> {
  const out: SymbolInformation[] = []
  let text: string
  try {
    text = await readFile(filePath, 'utf8')
  } catch {
    return out
  }
  const doc = parseYaml(text)
  const root = (doc as unknown as { contents?: unknown }).contents

  const locUri = pathToFileURL(filePath).toString()

  const pushRange = (name: string, kind: SymbolKind, range: VRange) => {
    out.push({ name, kind, location: LspLocation.create(locUri, range) })
  }

  // single interlocutor
  const singlePair = getPair(root, 'interlocutor')
  const single = singlePair?.value
  if (isObjectRecord(single)) {
    const namePair = getPair(single, 'name')
    const nameVal = namePair?.value
    const name = scalarValue(nameVal)
    if (typeof name === 'string') {
      const r = nodeAbsRange(text, nameVal, 0)
      if (r) pushRange(name, SymbolKind.Class, r)
    }
  }

  // interlocutors list
  const listPair = getPair(root, 'interlocutors')
  const listItems = itemsOf(listPair?.value)
  listItems.forEach((itMap) => {
    if (isObjectRecord(itMap)) {
      const namePair = getPair(itMap, 'name')
      const val = namePair?.value
      const name = scalarValue(val)
      if (typeof name === 'string') {
        const r = nodeAbsRange(text, val, 0)
        if (r) pushRange(name, SymbolKind.Class, r)
      }
    }
  })

  // macros list
  const macrosPair = getPair(root, 'macros')
  const macroItems = itemsOf(macrosPair?.value)
  macroItems.forEach((mMap) => {
    if (isObjectRecord(mMap)) {
      const namePair = getPair(mMap, 'name')
      const val = namePair?.value
      const name = scalarValue(val)
      if (typeof name === 'string') {
        const r = nodeAbsRange(text, val, 0)
        if (r) pushRange(name, SymbolKind.Function, r)
      }
    }
  })

  return out
}

export async function buildWorkspaceSymbols(
  roots?: string[]
): Promise<SymbolInformation[]> {
  const out: SymbolInformation[] = []
  const filesSet = new Set<string>()

  const systemChain = await resolveConfigChain({
    includeSystem: true,
  })
  for (const source of systemChain.sources) {
    if (source.path) filesSet.add(source.path)
  }

  if (Array.isArray(roots)) {
    for (const root of roots) {
      const chain = await resolveConfigChain({
        includeSystem: false,
        workspaceStartDir: root,
      })
      for (const source of chain.sources) {
        if (source.path) filesSet.add(source.path)
      }
    }
  }

  for (const file of filesSet) {
    const syms = await symbolsFromYamlFile(file)
    out.push(...syms)
  }

  return out
}
