// This recursively merges two values, applying `apply` to `base`, subject to
// the convention that if two elements of a list are objects with the same
// 'name' attribute, they're merged. Otherwise lists are concatenated. This
// fits with Lectic's convention of a 'name' attribute for tools/interlocutors.
export function mergeValues<A>(base: A, apply: A): A
export function mergeValues(base: unknown, apply: unknown): unknown {
  const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null
  const hasName = (v: unknown): v is Record<string, unknown> & { name: string } =>
    isObj(v) && typeof v["name"] === 'string'

  if (Array.isArray(base) && Array.isArray(apply)) {
    const baseObj: Record<string, unknown> = {}
    const applyObj: Record<string, unknown> = {}

    for (const item of base) {
      if (hasName(item)) {
        const key = item["name"]
        baseObj[key] = item
      } else {
        baseObj[Bun.randomUUIDv7()] = item
      }
    }
    for (const item of apply) {
      if (hasName(item)) {
        const key = item["name"]
        applyObj[key] = item
      } else {
        applyObj[Bun.randomUUIDv7()] = item
      }
    }
    return Object.values(mergeValues(baseObj, applyObj))
  }

  if (isObj(base) && isObj(apply)) {
    const fresh: Record<string, unknown> = {}
    const keys = new Set([...Object.keys(base), ...Object.keys(apply)])
    for (const key of keys) {
      fresh[key] = mergeValues(base[key], apply[key])
    }
    return fresh
  }

    return apply ?? base
}
