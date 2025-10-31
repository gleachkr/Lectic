import { fileURLToPath } from "url"
import { resolve as pathResolve } from "path"
import { stat, open } from "fs/promises"
import { expandEnv } from "../../utils/replace"

export type NormalizedUrl = {
  fsPath: string
  display: string
  fragment: string | null
  kind: 'file' | 'remote' | 'relative'
}

export function normalizeUrl(
  url: string,
  docDir: string | undefined
): NormalizedUrl {
  const trimmed = url.trim()
  const hash = trimmed.indexOf("#")
  const base = hash >= 0 ? trimmed.slice(0, hash) : trimmed
  const fragment = hash >= 0 ? trimmed.slice(hash + 1) : null

  const schemeMatch = base.match(/^([a-zA-Z][a-zA-Z0-9+.-]*):/)
  if (schemeMatch) {
    const scheme = schemeMatch[1].toLowerCase()
    if (scheme === 'file') {
      // Expand env vars inside the file:// path before interpreting
      const rest = base.slice('file://'.length)
      const expanded = expandEnv(rest, docDir ? { PWD : docDir } : {} )
      if (expanded.startsWith('/')) {
        return { fsPath: expanded, display: expanded, fragment, kind: 'file' }
      }
      // Fall back to URL parser for absolute forms; leave display as base
      try {
        const fsPath = fileURLToPath(new URL(base))
        return { fsPath, display: fsPath, fragment, kind: 'file' }
      } catch {
        // Not absolute or invalid
        return { fsPath: expanded, display: base, fragment, kind: 'file' }
      }
    }
    return { fsPath: '', display: base, fragment, kind: 'remote' }
  }

  const expanded = expandEnv(base, docDir ? { PWD : docDir } : {} )
  const fsPath = expanded.startsWith('/')
    ? expanded
    : (docDir ? pathResolve(docDir, expanded) : expanded)
  return { fsPath, display: fsPath, fragment, kind: expanded.startsWith('/') ? 'file' : 'relative' }
}

export async function pathExists(p: string): Promise<boolean> {
  if (!p) return false
  try {
    await stat(p)
    return true
  } catch {
    return false
  }
}

export function hasGlobChars(p: string): boolean {
  return /[*?[\]{}]/.test(p)
}

export async function globHasMatches(
  pattern: string,
  cwd: string | undefined
): Promise<boolean> {
  try {
    // Prefer scanning relative to cwd when provided
    if (cwd) {
      const glob = new Bun.Glob(pattern)
      for await (const _ of glob.scan({ cwd })) return true
    } else {
      const glob = new Bun.Glob(pattern)
      for await (const _ of glob.scan()) return true
    }
    // If absolute, try scanning from root as a fallback
    if (pattern.startsWith('/')) {
      const glob = new Bun.Glob(pattern.slice(1))
      for await (const _ of glob.scan({ cwd: '/' })) return true
    }
  } catch {
    // Ignore glob errors; treat as no matches
  }
  return false
}

export async function readHeadPreview(
  p: string,
  opts?: { maxBytes?: number, maxLines?: number, timeoutMs?: number }
): Promise<string | null> {
  const maxBytes = opts?.maxBytes ?? 2048
  const maxLines = opts?.maxLines ?? 40
  const timeoutMs = opts?.timeoutMs ?? 80

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const fh = await open(p, 'r')
    try {
      const buf = Buffer.allocUnsafe(maxBytes)
      const { bytesRead } = await fh.read(buf, 0, maxBytes, 0)
      const slice = buf.subarray(0, bytesRead)
      if (!isTextBuffer(slice)) return null
      const text = slice.toString('utf8')
      const lines = text.split(/\r?\n/).slice(0, maxLines)
      return lines.join("\n")
    } finally {
      await fh.close()
    }
  } catch {
    if (controller.signal.aborted) return null
    return null
  } finally {
    clearTimeout(timer)
  }
}

export function isTextBuffer(buf: Buffer): boolean {
  if (buf.includes(0)) return false
  let nonPrintable = 0
  const len = buf.length || 1
  for (const b of buf) {
    if (
      b === 9 || b === 10 || b === 13 || // \t, \n, \r
      (b >= 32 && b <= 126) || // ASCII printable
      (b >= 128) // assume UTF-8 multibyte is fine
    ) {
      continue
    }
    nonPrintable++
    if (nonPrintable / len > 0.3) return false
  }
  return true
}
