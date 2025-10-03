import { mergedHeaderSpecForDoc } from "../parsing/parse"
import { Macro, type MacroSpec } from "../types/macro"

export async function buildMacroIndex(
  docText: string,
  docDir: string | undefined
): Promise<Macro[]> {
  try {
    const spec = await mergedHeaderSpecForDoc(docText, docDir)
    const macros: MacroSpec[] = (spec?.macros ?? []) as MacroSpec[]
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
