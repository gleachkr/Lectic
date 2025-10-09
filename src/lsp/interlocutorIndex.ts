import type { LecticHeaderSpec } from "../types/lectic"
import type { Interlocutor } from "../types/interlocutor"

export function buildInterlocutorIndex(spec : LecticHeaderSpec): Interlocutor[] {
    const interlocutors : Interlocutor[] = []
    const seen = new Set<string>()
    const push = (i: Interlocutor) => {
        if (!seen.has(i.name)) { seen.add(i.name); interlocutors.push(i) }
    }
    if ("interlocutor" in spec) {
        push(spec.interlocutor) 
        // we add this before interlocutors; the way that the spec merging
        // works, there might actually be a difference between this and
        // a similarly named entry in interlocutors, but spec.interlocutor will
        // be the one that actually speaks
    }
    if (Array.isArray(spec?.interlocutors)) {
        for (const it of spec.interlocutors) {
            if (typeof it === "object" && typeof it?.name === "string") {
                push(it)
            }
        }
    }
    return interlocutors
}

export function previewInterlocutor(interlocutor : Interlocutor): { detail: string, documentation: string } {
  const trim = (s: string, n: number) =>
    s.length <= n ? s : (s.slice(0, n - 1) + "…")

  const detail = interlocutor.name
  const documentation = trim(interlocutor.prompt, 500)
  return { detail, documentation }
}
