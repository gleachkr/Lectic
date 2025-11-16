import type { LLMProvider } from "../../types/provider"
import { getDefaultProvider, isLLMProvider } from "../../types/provider"
import { mergedHeaderSpecForDocDetailed } from "../../parsing/parse"
import { getValue, stringOf } from "../utils/yamlAst"
import { isObjectRecord } from "../../types/guards"

/**
 * Compute the effective provider for a YAML path to a `model` field.
 * Uses the merged spec (system/workspace/header) but locates the
 * interlocutor by name using the local YAML AST to map indexes.
 */
export async function effectiveProviderForPath(
  docText: string,
  docDir: string | undefined,
  localDoc: unknown,
  path: (string | number)[],
): Promise<LLMProvider | null> {
  try {
    const mergeRes = await mergedHeaderSpecForDocDetailed(docText, docDir)
    const spec = mergeRes.spec as unknown

    const root = isObjectRecord(spec) ? spec as Record<string, unknown> : {}

    const toProv = (p: unknown): LLMProvider | null => {
      if (isLLMProvider(p)) return p
      try { return getDefaultProvider() } catch { return null }
    }

    if (path[0] === 'interlocutor') {
      const inter = isObjectRecord(root['interlocutor'])
        ? root['interlocutor'] as Record<string, unknown>
        : undefined
      const p = inter?.['provider']
      return toProv(p)
    }

    if (path[0] === 'interlocutors' && typeof path[1] === 'number') {
      // Identify local name at the given index from local YAML AST
      const list = getValue(localDoc as unknown, 'interlocutors')
      const seq = (list as { items?: unknown })
      const items = Array.isArray(seq?.items) ? seq.items as unknown[] : []
      const it = items[path[1] as number]
      const localName = stringOf(getValue(it, 'name'))

      // Find merged entry by name and return its provider
      const mergedArr = Array.isArray(root['interlocutors'])
        ? (root['interlocutors'] as unknown[])
        : []
      let fromMerged: unknown = undefined
      if (typeof localName === 'string') {
        for (const m of mergedArr) {
          if (isObjectRecord(m) && typeof m['name'] === 'string' && m['name'] === localName) {
            fromMerged = m['provider']
            break
          }
        }
      }
      return toProv(fromMerged)
    }
  } catch {
    // fall through
  }
  try { return getDefaultProvider() } catch { return null }
}
