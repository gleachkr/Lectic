import * as YAML from "yaml"
import type { Range } from "vscode-languageserver"
import { Range as LspRange } from "vscode-languageserver/node"
import { offsetToPosition } from "../positions"
import { isObjectRecord } from "../../types/guards"

const parseOpts: YAML.ParseOptions & { [k: string]: unknown } = {
  keepCstNodes: true,
  keepNodeTypes: true,
  logLevel: "silent",
}

export function itemsOf(v: unknown): unknown[] {
  if (!isObjectRecord(v)) return []
  const it = v["items"]
  return Array.isArray(it) ? it : []
}

export function scalarValue(n: unknown): unknown {
  return isObjectRecord(n) ? n["value"] : undefined
}

export function stringOf(n: unknown): string | undefined {
  const v = scalarValue(n)
  return typeof v === "string" ? v : undefined
}

export function parseYaml(text: string) {
  return YAML.parseDocument(text, parseOpts)
}

export function nodeAbsRange(
  text: string,
  node: unknown,
  baseOffset: number
): Range | null {
  const r = isObjectRecord(node) ? node["range"] : undefined
  if (Array.isArray(r) && typeof r[0] === 'number' && typeof r[2] === 'number') {
    const start = baseOffset + r[0]
    const end = baseOffset + r[2]
    return LspRange.create(offsetToPosition(text, start), offsetToPosition(text, end))
  }
  const c = isObjectRecord(node) && isObjectRecord(node["cstNode"]) 
    ? node["cstNode"]
    : undefined
  const off = c?.["offset"]
  const end = c?.["end"]
  if (typeof off === 'number' && typeof end === 'number') {
    const start = baseOffset + off
    const stop = baseOffset + end
    return LspRange.create(offsetToPosition(text, start), offsetToPosition(text, stop))
  }
  return null
}

export function getPair(
  map: unknown,
  key: string
): { key: unknown, value: unknown } | undefined {
  for (const it of itemsOf(map)) {
    const keyNode = isObjectRecord(it) ? it["key"] : undefined
    const k = scalarValue(keyNode)
    if (k === key) {
      return {
        key: keyNode,
        value: isObjectRecord(it) ? it["value"] : undefined
      }
    }
  }
  return undefined
}

export const getValue = (map: unknown, key: string): unknown =>
  getPair(map, key)?.value
