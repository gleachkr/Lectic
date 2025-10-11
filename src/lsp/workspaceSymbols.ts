import type { SymbolInformation } from "vscode-languageserver"
import { SymbolKind } from "vscode-languageserver"
import { Location as LspLocation, Range as LspRange } from "vscode-languageserver/node"
import * as YAML from "yaml"
import { readFile } from "fs/promises"
import { join } from "path"
import { pathToFileURL } from "url"
import { lecticConfigDir } from "../utils/xdg"
import { offsetToPosition } from "./positions"

function nodeAbsRange(node: any, baseOffset: number): { start: number, end: number } | null {
  const r = (node as any)?.range
  if (Array.isArray(r) && typeof r[0] === 'number' && typeof r[2] === 'number') {
    const start = baseOffset + r[0]
    const end = baseOffset + r[2]
    return { start, end }
  }
  const c = (node as any)?.cstNode as any
  if (c && typeof c.offset === 'number' && typeof c.end === 'number') {
    const start = baseOffset + c.offset
    const end = baseOffset + c.end
    return { start, end }
  }
  return null
}

function getPair(map: any, key: string): any | undefined {
  const items: any[] = (map && typeof map === 'object' && Array.isArray(map.items))
    ? map.items : []
  for (const it of items) {
    const k = (it?.key as any)?.value
    if (k === key) return it
  }
  return undefined
}

async function symbolsFromYamlFile(filePath: string): Promise<SymbolInformation[]> {
  const out: SymbolInformation[] = []
  let text: string
  try {
    text = await readFile(filePath, 'utf8')
  } catch {
    return out
  }
  const doc = YAML.parseDocument(text, {
    keepCstNodes: true,
    keepNodeTypes: true,
    logLevel: 'silent'
  } as any)
  const root: any = doc.contents

  const locUri = pathToFileURL(filePath).toString()

  const push = (name: string, kind: SymbolKind, start: number, end: number) => {
    const range = LspRange.create(offsetToPosition(text, start), offsetToPosition(text, end))
    out.push({
      name,
      kind,
      location: LspLocation.create(locUri, range)
    })
  }

  // single interlocutor
  const singlePair = getPair(root, 'interlocutor')
  const single = singlePair?.value
  if (single && typeof single === 'object') {
    const namePair = getPair(single, 'name')
    const nameVal = namePair?.value
    if (nameVal && typeof (nameVal as any).value === 'string') {
      const r = nodeAbsRange(nameVal, 0)
      if (r) push((nameVal as any).value, SymbolKind.Class, r.start, r.end)
    }
  }

  // interlocutors list
  const listPair = getPair(root, 'interlocutors')
  const listItems: any[] = Array.isArray(listPair?.value?.items) ? listPair.value.items : []
  listItems.forEach((itMap) => {
    if (itMap && typeof itMap === 'object') {
      const namePair = getPair(itMap, 'name')
      const val = namePair?.value
      if (val && typeof (val as any).value === 'string') {
        const r = nodeAbsRange(val, 0)
        if (r) push((val as any).value, SymbolKind.Class, r.start, r.end)
      }
    }
  })

  // macros list
  const macrosPair = getPair(root, 'macros')
  const macroItems: any[] = Array.isArray(macrosPair?.value?.items) ? macrosPair.value.items : []
  macroItems.forEach((mMap) => {
    if (mMap && typeof mMap === 'object') {
      const namePair = getPair(mMap, 'name')
      const val = namePair?.value
      if (val && typeof (val as any).value === 'string') {
        const r = nodeAbsRange(val, 0)
        if (r) push((val as any).value, SymbolKind.Function, r.start, r.end)
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
  if (Array.isArray(roots)) {
    for (const r of roots) filesSet.add(join(r, 'lectic.yaml'))
  }
  filesSet.add(join(lecticConfigDir(), 'lectic.yaml'))
  for (const f of filesSet) {
    const syms = await symbolsFromYamlFile(f)
    out.push(...syms)
  }
  return out
}
