import { mergedHeaderSpecForDoc } from "../parsing/parse"
import { isLecticHeaderSpec } from "../types/lectic"

export async function buildInterlocutorIndex(docText: string, docDir: string | undefined): Promise<string[]> {
    const spec : unknown = await mergedHeaderSpecForDoc(docText, docDir)
    if (isLecticHeaderSpec(spec)) {
        const names: string[] = []
        const seen = new Set<string>()
        const push = (n: string) => {
            const key = n.toLowerCase()
            if (!seen.has(key)) { seen.add(key); names.push(n) }
        }
        if ("interlocutor" in spec && typeof spec?.interlocutor?.name === "string") {
            push(spec.interlocutor.name)
        }
        if (Array.isArray(spec?.interlocutors)) {
            for (const it of spec.interlocutors) {
                if (typeof it === "object" && typeof it?.name === "string") {
                    push(it.name)
                }
            }
        }
        return names
    }
    return []
}
