import type { AnalysisBundle } from "./analysisTypes"
import { buildBundle } from "./analysis"

export function buildTestBundle(docText: string, uri = "file:///doc.lec", version = 1): AnalysisBundle {
  return buildBundle(docText, uri, version)
}
