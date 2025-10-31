import type { Range } from "vscode-languageserver"
import { Range as LspRange } from "vscode-languageserver/node"
import * as YAML from "yaml"
import { offsetToPosition } from "./positions"

function findHeaderMatch(text: string): RegExpExecArray | null {
  const re = /^---\n([\s\S]*?)\n(?:---|\.\.\.)/m
  return re.exec(text)
}

function nodeAbsRange(text: string, node: any, baseOffset: number): Range | null {
  // Prefer node.range: [start, valueEnd, end]
  const r = node?.range
  if (Array.isArray(r) && typeof r[0] === 'number' && typeof r[2] === 'number') {
    const start = baseOffset + r[0]
    const end = baseOffset + r[2]
    return LspRange.create(offsetToPosition(text, start), offsetToPosition(text, end))
  }
  // Fallback to CST node offsets
  const c = node?.cstNode
  if (c && typeof c.offset === 'number' && typeof c.end === 'number') {
    const start = baseOffset + c.offset
    const end = baseOffset + c.end
    return LspRange.create(offsetToPosition(text, start), offsetToPosition(text, end))
  }
  return null
}

function getPair(map: any, key: string): any | undefined {
  const items: any[] = (map && typeof map === 'object' && Array.isArray(map.items))
    ? map.items : []
  for (const it of items) {
    const k = it?.key?.value
    if (k === key) return it
  }
  return undefined
}

export type YamlPathRange = { path: (string | number)[], range: Range }

export type HeaderRangeIndex = {
  headerFullRange: Range,
  headerContentStartOffset: number,
  interlocutorNameRanges: Array<{ name: string, range: Range }>,
  macroNameRanges: Array<{ name: string, range: Range }>,
  agentTargetRanges: Array<{ target: string, range: Range }>,
  bundleTargetRanges: Array<{ target: string, range: Range }>,
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

  const doc = YAML.parseDocument(yamlText, {
    keepCstNodes: true,
    keepNodeTypes: true,
    logLevel: "silent"
  } as any)

  const interlocutorNameRanges: Array<{ name: string, range: Range }> = []
  const macroNameRanges: Array<{ name: string, range: Range }> = []
  const agentTargetRanges: Array<{ target: string, range: Range }> = []
  const bundleTargetRanges: Array<{ target: string, range: Range }> = []
  const fieldRanges: YamlPathRange[] = []

  const root = doc.contents

  function pushField(path: (string | number)[], node: any) {
    const r = nodeAbsRange(docText, node, contentStart)
    if (r) fieldRanges.push({ path, range: r })
  }

  // single interlocutor
  const singlePair = getPair(root, 'interlocutor')
  const single = singlePair?.value
  if (single && typeof single === 'object') {
    // whole mapping
    pushField(['interlocutor'], single)

    const namePair = getPair(single, 'name')
    const nameVal = namePair?.value
    if (nameVal && typeof nameVal.value === 'string') {
      const r = nodeAbsRange(docText, nameVal, contentStart)
      if (r) interlocutorNameRanges.push({ name: nameVal.value, range: r })
      pushField(['interlocutor','name'], nameVal)
    }
    const promptPair = getPair(single, 'prompt')
    if (promptPair?.value) pushField(['interlocutor','prompt'], promptPair.value)
    const providerPair = getPair(single, 'provider')
    if (providerPair?.value) pushField(['interlocutor','provider'], providerPair.value)
    const modelPair = getPair(single, 'model')
    if (modelPair?.value) pushField(['interlocutor','model'], modelPair.value)
    const tempPair = getPair(single, 'temperature')
    if (tempPair?.value) pushField(['interlocutor','temperature'], tempPair.value)
    const mtokPair = getPair(single, 'max_tokens')
    if (mtokPair?.value) pushField(['interlocutor','max_tokens'], mtokPair.value)
    const mtuPair = getPair(single, 'max_tool_use')
    if (mtuPair?.value) pushField(['interlocutor','max_tool_use'], mtuPair.value)
    const reminderPair = getPair(single, 'reminder')
    if (reminderPair?.value) pushField(['interlocutor','reminder'], reminderPair.value)
    const nocachePair = getPair(single, 'nocache')
    if (nocachePair?.value) pushField(['interlocutor','nocache'], nocachePair.value)

    const toolsPair = getPair(single, 'tools')
    if (toolsPair?.value) pushField(['interlocutor','tools'], toolsPair.value)
    const tools: any[] = Array.isArray(toolsPair?.value?.items) ? toolsPair.value.items : []
    tools.forEach((t, i) => {
      pushField(['interlocutor','tools', i], t)
      const agentPair = getPair(t, 'agent')
      const aval = agentPair?.value
      if (aval && typeof aval.value === 'string') {
        const r = nodeAbsRange(docText, aval, contentStart)
        if (r) agentTargetRanges.push({ target: aval.value, range: r })
        pushField(['interlocutor','tools', i, 'agent'], aval)
      }
      const bundlePair = getPair(t, 'bundle')
      const bval = bundlePair?.value
      if (bval && typeof bval.value === 'string') {
        const r = nodeAbsRange(docText, bval, contentStart)
        if (r) bundleTargetRanges.push({ target: bval.value, range: r })
        pushField(['interlocutor','tools', i, 'bundle'], bval)
      }
    })
  }

  // interlocutors list
  const listPair = getPair(root, 'interlocutors')
  if (listPair?.value) pushField(['interlocutors'], listPair.value)
  const listItems: any[] = Array.isArray(listPair?.value?.items) ? listPair.value.items : []
  listItems.forEach((itMap, idx) => {
    if (itMap && typeof itMap === 'object') {
      pushField(['interlocutors', idx], itMap)
      const namePair = getPair(itMap, 'name')
      const val = namePair?.value
      if (val && typeof val.value === 'string') {
        const r = nodeAbsRange(docText, val, contentStart)
        if (r) interlocutorNameRanges.push({ name: val.value, range: r })
        pushField(['interlocutors', idx, 'name'], val)
      }
      const promptPair = getPair(itMap, 'prompt')
      if (promptPair?.value) pushField(['interlocutors', idx, 'prompt'], promptPair.value)
      const providerPair = getPair(itMap, 'provider')
      if (providerPair?.value) pushField(['interlocutors', idx, 'provider'], providerPair.value)
      const modelPair = getPair(itMap, 'model')
      if (modelPair?.value) pushField(['interlocutors', idx, 'model'], modelPair.value)
      const tempPair = getPair(itMap, 'temperature')
      if (tempPair?.value) pushField(['interlocutors', idx, 'temperature'], tempPair.value)
      const mtokPair = getPair(itMap, 'max_tokens')
      if (mtokPair?.value) pushField(['interlocutors', idx, 'max_tokens'], mtokPair.value)
      const mtuPair = getPair(itMap, 'max_tool_use')
      if (mtuPair?.value) pushField(['interlocutors', idx, 'max_tool_use'], mtuPair.value)
      const reminderPair = getPair(itMap, 'reminder')
      if (reminderPair?.value) pushField(['interlocutors', idx, 'reminder'], reminderPair.value)
      const nocachePair = getPair(itMap, 'nocache')
      if (nocachePair?.value) pushField(['interlocutors', idx, 'nocache'], nocachePair.value)

      const toolsPair = getPair(itMap, 'tools')
      if (toolsPair?.value) pushField(['interlocutors', idx, 'tools'], toolsPair.value)
      const tools: any[] = Array.isArray(toolsPair?.value?.items) ? toolsPair.value.items : []
      for (let i = 0; i < tools.length; i++) {
        const tMap = tools[i]
        pushField(['interlocutors', idx, 'tools', i], tMap)
        const agentPair = getPair(tMap, 'agent')
        const aval = agentPair?.value
        if (aval && typeof aval.value === 'string') {
          const r = nodeAbsRange(docText, aval, contentStart)
          if (r) agentTargetRanges.push({ target: aval.value, range: r })
          pushField(['interlocutors', idx, 'tools', i, 'agent'], aval)
        }
        const bundlePair = getPair(tMap, 'bundle')
        const bval = bundlePair?.value
        if (bval && typeof bval.value === 'string') {
          const r = nodeAbsRange(docText, bval, contentStart)
          if (r) bundleTargetRanges.push({ target: bval.value, range: r })
          pushField(['interlocutors', idx, 'tools', i, 'bundle'], bval)
        }
      }
    }
  })

  // macros list
  const macrosPair = getPair(root, 'macros')
  if (macrosPair?.value) pushField(['macros'], macrosPair.value)
  const macroItems: any[] = Array.isArray(macrosPair?.value?.items) ? macrosPair.value.items : []
  macroItems.forEach((mMap, i) => {
    if (mMap && typeof mMap === 'object') {
      pushField(['macros', i], mMap)
      const namePair = getPair(mMap, 'name')
      const val = namePair?.value
      if (val && typeof val.value === 'string') {
        const r = nodeAbsRange(docText, val, contentStart)
        if (r) macroNameRanges.push({ name: val.value, range: r })
        pushField(['macros', i, 'name'], val)
      }
      const expPair = getPair(mMap, 'expansion')
      if (expPair?.value) pushField(['macros', i, 'expansion'], expPair.value)
    }
  })

  // hooks list
  const hooksPair = getPair(root, 'hooks')
  if (hooksPair?.value) pushField(['hooks'], hooksPair.value)
  const hookItems: any[] = Array.isArray(hooksPair?.value?.items) ? hooksPair.value.items : []
  hookItems.forEach((hMap, i) => {
    if (hMap && typeof hMap === 'object') {
      pushField(['hooks', i], hMap)
      const onPair = getPair(hMap, 'on')
      if (onPair?.value) pushField(['hooks', i, 'on'], onPair.value)
      const doPair = getPair(hMap, 'do')
      if (doPair?.value) pushField(['hooks', i, 'do'], doPair.value)
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
    bundleTargetRanges,
    fieldRanges,
    findRangesByPath
  }
}

function samePath(a: (string|number)[], b: (string|number)[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}
