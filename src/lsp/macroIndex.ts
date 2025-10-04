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

export function previewMacro(macro : Macro): { detail: string, documentation: string } {
  const trim = (s: string, n: number) =>
    s.length <= n ? s : (s.slice(0, n - 1) + "…")

  const detail = macro.name
  const documentation = trim(macro.expansion, 500)
  return { detail, documentation }
}
