import { join, dirname } from "path"
import { getYaml } from "../parsing/parse"
import { lecticConfigDir } from "../utils/xdg"
import { LecticHeader } from "../types/lectic"
import { Macro } from "../types/macro"

function getDirFromUri(uri: string): string {
  try {
    const u = new URL(uri)
    return dirname(u.pathname)
  } catch {
    return dirname(uri)
  }
}

export async function buildMacroIndex(
  docText: string,
  docUri: string
): Promise<Macro[]> {
  const rawYaml = getYaml(docText) ?? ""
  const docDir = getDirFromUri(docUri)

  const systemPath = join(lecticConfigDir(), "lectic.yaml")
  const workspacePath = join(docDir, "lectic.yaml")

  const [systemYaml, workspaceYaml] = await Promise.all([
    Bun.file(systemPath).text().catch(_ => null),
    Bun.file(workspacePath).text().catch(_ => null)
  ])

  try {
    return LecticHeader.mergeInterlocutorSpecs([
      systemYaml, workspaceYaml, rawYaml
    ]).macros
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
