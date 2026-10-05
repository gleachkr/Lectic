import { type Root } from "mdast"

// Cache only chunks present in the current document, not their edit history.
export class ChunkAstCache {
  private readonly entries = new Map<string, Root>()

  constructor(private readonly parse: (text: string) => Root) {}

  get size(): number {
    return this.entries.size
  }

  retain(hashes: ReadonlySet<string>): void {
    for (const hash of this.entries.keys()) {
      if (!hashes.has(hash)) this.entries.delete(hash)
    }
  }

  get(hash: string, text: string): Root {
    const cached = this.entries.get(hash)
    if (cached) return cached

    const ast = this.parse(text)
    this.entries.set(hash, ast)
    return ast
  }
}
