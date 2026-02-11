import { isAbsolute, normalize, resolve } from "path"

const LOCAL_PREFIX = "local:"
const FILE_LOCAL_PREFIX = "file:local:"

function isStrictRelativeLocalPath(path: string): boolean {
  return (
    path.startsWith("./") ||
    path.startsWith("../") ||
    path.startsWith(".\\") ||
    path.startsWith("..\\")
  )
}

function ensureBaseDir(baseDir: string | undefined): string {
  if (typeof baseDir !== "string" || baseDir.length === 0) {
    throw new Error("local: paths require a base directory")
  }
  return baseDir
}

function resolveStrictLocalPath(path: string, baseDir: string | undefined): string {
  if (isAbsolute(path) || !isStrictRelativeLocalPath(path)) {
    throw new Error("local: paths must start with ./ or ../")
  }

  const root = ensureBaseDir(baseDir)
  return normalize(resolve(root, path))
}

export function rewriteLocalValue(value: string, baseDir: string | undefined): string {
  if (value.startsWith(FILE_LOCAL_PREFIX)) {
    const tail = value.slice(FILE_LOCAL_PREFIX.length)
    const absolutePath = resolveStrictLocalPath(tail, baseDir)
    return `file:${absolutePath}`
  }

  if (value.startsWith(LOCAL_PREFIX)) {
    const tail = value.slice(LOCAL_PREFIX.length)

    if (tail.startsWith("file:")) {
      throw new Error("use file:local:./... instead of local:file:...")
    }

    if (tail.startsWith("exec:")) {
      throw new Error("local: does not compose with exec:")
    }

    return resolveStrictLocalPath(tail, baseDir)
  }

  return value
}

function rewriteLocalInNodeDetailed(
  node: unknown,
  baseDir: string | undefined
): { value: unknown, changed: boolean } {
  if (typeof node === "string") {
    const value = rewriteLocalValue(node, baseDir)
    return { value, changed: value !== node }
  }

  if (Array.isArray(node)) {
    let changed = false
    const nextItems = node.map(item => {
      const next = rewriteLocalInNodeDetailed(item, baseDir)
      if (next.changed) changed = true
      return next.value
    })

    if (!changed) return { value: node, changed: false }
    return { value: nextItems, changed: true }
  }

  if (typeof node === "object" && node !== null) {
    let changed = false
    const out: Record<string, unknown> = {}

    for (const [key, value] of Object.entries(node)) {
      const next = rewriteLocalInNodeDetailed(value, baseDir)
      out[key] = next.value
      if (next.changed) changed = true
    }

    if (!changed) return { value: node, changed: false }
    return { value: out, changed: true }
  }

  return { value: node, changed: false }
}

export function rewriteLocalInNode(node: unknown, baseDir: string | undefined): unknown {
  return rewriteLocalInNodeDetailed(node, baseDir).value
}
