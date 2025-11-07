import type { Range } from "vscode-languageserver"
import { Range as LspRange } from "vscode-languageserver/node"
import { offsetToPosition } from "./positions"
import { parseYaml, itemsOf, nodeAbsRange, getPair, getValue, stringOf } from "./utils/yamlAst"
import { isObjectRecord } from "../types/guards"

function findHeaderMatch(text: string): RegExpExecArray | null {
  const re = /^---\n([\s\S]*?)\n(?:---|\.\.\.)/m
  return re.exec(text)
}


export type YamlPathRange = { path: (string | number)[], range: Range }

export type HeaderRangeIndex = {
  headerFullRange: Range,
  headerContentStartOffset: number,
  interlocutorNameRanges: Array<{ name: string, range: Range }>,
  macroNameRanges: Array<{ name: string, range: Range }>,
  agentTargetRanges: Array<{ target: string, range: Range }>,
  kitTargetRanges: Array<{ target: string, range: Range }>,
  fieldRanges: YamlPathRange[],
  findRangesByPath: (path: (string | number)[]) => Range[]
}

export function buildHeaderRangeIndex(docText: string): HeaderRangeIndex | null {
  const m = findHeaderMatch(docText)
  if (!m) return null
  const yamlText = m[1] ?? ""
  const headerStart = m.index
  const contentStart = headerStart + 4 /* ---\n */
  const headerEnd = headerStart + (m[0]?.length ?? 0)
  const headerFullRange = LspRange.create(
    offsetToPosition(docText, headerStart),
    offsetToPosition(docText, headerEnd)
  )

  const doc = parseYaml(yamlText)

  const interlocutorNameRanges: Array<{ name: string, range: Range }> = []
  const macroNameRanges: Array<{ name: string, range: Range }> = []
  const agentTargetRanges: Array<{ target: string, range: Range }> = []
  const kitTargetRanges: Array<{ target: string, range: Range }> = []
  const fieldRanges: YamlPathRange[] = []

  const root = doc.contents

  function pushField(path: (string | number)[], node: unknown) {
    const r = nodeAbsRange(docText, node, contentStart)
    if (r) fieldRanges.push({ path, range: r })
  }

  const pushIf = (map: unknown, key: string, path: (string | number)[]) => {
    const v = getValue(map, key)
    if (v) pushField(path, v)
  }

  function indexTools(toolsVal: unknown, basePath: (string | number)[]) {
    if (toolsVal) pushField([...basePath, 'tools'], toolsVal)
    const tools = itemsOf(toolsVal)
    tools.forEach((t, i) => {
      pushField([...basePath, 'tools', i], t)
      const aval = getValue(t, 'agent')
      const agent = stringOf(aval)
      if (agent) {
        const r = nodeAbsRange(docText, aval, contentStart)
        if (r) agentTargetRanges.push({ target: agent, range: r })
        pushField([...basePath, 'tools', i, 'agent'], aval)
      }
      const bval = getValue(t, 'kit')
      const kit = stringOf(bval)
      if (kit) {
        const r = nodeAbsRange(docText, bval, contentStart)
        if (r) kitTargetRanges.push({ target: kit, range: r })
        pushField([...basePath, 'tools', i, 'kit'], bval)
      }
    })
  }

  function indexInterlocutor(map: unknown, basePath: (string | number)[]) {
    if (!isObjectRecord(map)) return
    pushField(basePath, map)

    const nameNode = getValue(map, 'name')
    const name = stringOf(nameNode)
    if (name) {
      const r = nodeAbsRange(docText, nameNode, contentStart)
      if (r) interlocutorNameRanges.push({ name, range: r })
      pushField([...basePath, 'name'], nameNode)
    }

    pushIf(map, 'prompt', [...basePath, 'prompt'])
    pushIf(map, 'provider', [...basePath, 'provider'])
    pushIf(map, 'model', [...basePath, 'model'])
    pushIf(map, 'temperature', [...basePath, 'temperature'])
    pushIf(map, 'max_tokens', [...basePath, 'max_tokens'])
    pushIf(map, 'max_tool_use', [...basePath, 'max_tool_use'])
    pushIf(map, 'reminder', [...basePath, 'reminder'])
    pushIf(map, 'nocache', [...basePath, 'nocache'])

    const toolsVal = getValue(map, 'tools')
    indexTools(toolsVal, basePath)
  }

  // single interlocutor
  const single = getPair(root, 'interlocutor')?.value
  if (isObjectRecord(single)) {
    indexInterlocutor(single, ['interlocutor'])
  }

  // interlocutors list
  const listVal = getPair(root, 'interlocutors')?.value
  if (listVal) pushField(['interlocutors'], listVal)
  const listItems = itemsOf(listVal)
  listItems.forEach((itMap, idx) => {
    indexInterlocutor(itMap, ['interlocutors', idx])
  })

  // macros list
  const macrosVal = getPair(root, 'macros')?.value
  if (macrosVal) pushField(['macros'], macrosVal)
  const macroItems = itemsOf(macrosVal)
  macroItems.forEach((mMap, i) => {
    if (isObjectRecord(mMap)) {
      pushField(['macros', i], mMap)
      const val = getValue(mMap, 'name')
      const name = stringOf(val)
      if (name) {
        const r = nodeAbsRange(docText, val, contentStart)
        if (r) macroNameRanges.push({ name, range: r })
        pushField(['macros', i, 'name'], val)
      }
      pushIf(mMap, 'expansion', ['macros', i, 'expansion'])
    }
  })

  // hooks list
  const hooksVal = getPair(root, 'hooks')?.value
  if (hooksVal) pushField(['hooks'], hooksVal)
  const hookItems = itemsOf(hooksVal)
  hookItems.forEach((hMap, i) => {
    if (isObjectRecord(hMap)) {
      pushField(['hooks', i], hMap)
      pushIf(hMap, 'on', ['hooks', i, 'on'])
      pushIf(hMap, 'do', ['hooks', i, 'do'])
    }
  })

  const findRangesByPath = (path: (string | number)[]): Range[] =>
    fieldRanges.filter(fr => samePath(fr.path, path)).map(fr => fr.range)

  return {
    headerFullRange,
    headerContentStartOffset: contentStart,
    interlocutorNameRanges,
    macroNameRanges,
    agentTargetRanges,
    kitTargetRanges,
    fieldRanges,
    findRangesByPath
  }
}

function samePath(a: (string|number)[], b: (string|number)[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}
