import { loadFrom } from "./loader"

export type HeaderSources = Record<string, string>

export function createFetchWithHeaderSources(
  headerSources: HeaderSources | undefined,
  baseFetch: typeof fetch = fetch,
): typeof fetch {
  if (!headerSources || Object.keys(headerSources).length === 0) {
    return baseFetch
  }

  const wrapped = Object.assign(
    async function (
      input: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) {
      const baseHeaders =
        init?.headers ??
        (input instanceof Request ? input.headers : undefined)

      const headers = new Headers(baseHeaders)

      for (const [key, src] of Object.entries(headerSources)) {
        const loaded = await loadFrom(src)
        if (typeof loaded !== "string") continue

        const v = loaded.trim()
        if (!v) continue

        headers.set(key, v)
      }

      return baseFetch(input, { ...init, headers })
    },
    baseFetch,
  )

  return wrapped
}
