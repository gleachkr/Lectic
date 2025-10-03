import { mergedHeaderSpecForDoc } from "../parsing/parse"

export async function buildInterlocutorIndex(docText: string, docDir: string | undefined): Promise<string[]> {
  const spec = await mergedHeaderSpecForDoc(docText, docDir)
  const names: string[] = []
  const seen = new Set<string>()
  const push = (n: string) => {
     const key = n.toLowerCase()
     if (!seen.has(key)) { seen.add(key); names.push(n) }
  }
  if (spec && typeof spec === "object") {
    if (typeof spec?.interlocutor?.name === "string") {
      push(spec.interlocutor.name)
    }
    if (Array.isArray(spec?.interlocutors)) {
      for (const it of spec.interlocutors) {
        if (typeof it === "object" && typeof it?.name === "string") {
            push(it.name)
        }
      }
    }
  }
  return names
}
