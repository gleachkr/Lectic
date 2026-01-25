import { mkdir, readFile, stat, writeFile } from "node:fs/promises"
import { dirname } from "node:path"
import { isObjectRecord } from "../types/guards"

type JsonCacheEnvelope<T> = {
  cachedAtMs: number
  value: T
}

function isJsonCacheEnvelope<T>(v: unknown): v is JsonCacheEnvelope<T> {
  return (
    isObjectRecord(v) &&
    typeof v["cachedAtMs"] === "number" &&
    "value" in v
  )
}

export async function readJsonCacheFile<T>(opt: {
  path: string
  maxAgeMs?: number
}): Promise<T | null> {
  try {
    if (opt.maxAgeMs !== undefined) {
      const info = await stat(opt.path)
      const ageMs = Date.now() - info.mtimeMs
      if (ageMs > opt.maxAgeMs) return null
    }

    const raw = await readFile(opt.path, "utf8")
    const parsed: unknown = JSON.parse(raw)

    if (isJsonCacheEnvelope<T>(parsed)) {
      return parsed.value
    }

    return parsed as T
  } catch {
    return null
  }
}

export async function writeJsonCacheFile<T>(opt: {
  path: string
  value: T
}): Promise<void> {
  await mkdir(dirname(opt.path), { recursive: true })

  const env: JsonCacheEnvelope<T> = {
    cachedAtMs: Date.now(),
    value: opt.value,
  }

  await writeFile(opt.path, JSON.stringify(env, null, 2), "utf8")
}

export async function cachedJson<T>(opt: {
  path: string
  load: () => Promise<T>
  maxAgeMs?: number
}): Promise<{ value: T; cacheHit: boolean }> {
  const cached = await readJsonCacheFile<T>({
    path: opt.path,
    maxAgeMs: opt.maxAgeMs,
  })

  if (cached !== null) {
    return { value: cached, cacheHit: true }
  }

  const value = await opt.load()

  try {
    await writeJsonCacheFile({ path: opt.path, value })
  } catch {
    // Ignore cache write errors.
  }

  return { value, cacheHit: false }
}
