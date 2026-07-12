export type SearchableMemory = {
  id: number
  scope: string
  kind: string
  gist: string
  content: string
  source_file: string | null
  source_interlocutor: string | null
  status: string
}

export function memorySearchScore(
  row: SearchableMemory,
  rawQuery: string,
): number {
  const terms = rawQuery
    .normalize("NFKC")
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
  if (terms.length === 0) return 0

  const gist = row.gist.toLowerCase()
  const content = row.content.toLowerCase()
  const metadata = [
    row.id,
    row.scope,
    row.kind,
    row.status,
    row.source_file ?? "",
    row.source_interlocutor ?? "",
  ].join(" ").toLowerCase()

  let score = 0
  for (const term of terms) {
    if (gist.includes(term)) score += 12
    else if (content.includes(term)) score += 5
    else if (metadata.includes(term)) score += 3
    else return -1
  }
  return score
}
