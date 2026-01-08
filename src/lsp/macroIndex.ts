import { Macro, type MacroSpec } from "../types/macro"
import type { LecticHeaderSpec } from "../types/lectic"

export function buildMacroIndex(spec : LecticHeaderSpec): Macro[] {
  try {
    const macros: MacroSpec[] = spec?.macros ?? []
    return macros.map(m => new Macro(m))
  } catch {
    return []
  }
}

export function previewMacro(
  macro : Macro
): { detail: string, documentation: string, description?: string } {
  const trim = (s: string, n: number) =>
    s.length <= n ? s : (s.slice(0, n - 1) + "…")

  const detail = macro.name
  const description = macro.description
    ? trim(macro.description, 500)
    : undefined

  if (!macro.pre) {
    return { detail, description, documentation: trim(macro.expansion, 500) }
  }

  let documentation = ""
  if (macro.pre) {
    documentation += `pre: ${trim(macro.pre, 250)}\n`
  }
  if (macro.post) {
    documentation += `post: ${trim(macro.post, 250)}`
  }

  return { detail, description, documentation: documentation.trim() }
}
