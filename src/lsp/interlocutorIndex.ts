import type { LecticHeaderSpec } from "../types/lectic"

export function buildInterlocutorIndex(spec : LecticHeaderSpec): string[] {
    const names: string[] = []
    const seen = new Set<string>()
    const push = (n: string) => {
        const key = n.toLowerCase()
        if (!seen.has(key)) { seen.add(key); names.push(n) }
    }
    if ("interlocutor" in spec) {
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
