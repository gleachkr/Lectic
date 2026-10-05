import { describe, expect, test } from "bun:test"
import { remark } from "remark"
import remarkDirective from "remark-directive"
import { ChunkAstCache } from "./chunkCache"
import {
  hashChunk, mergeChunkAsts, shiftPositions, splitChunks,
} from "./chunking"
import { buildBundleFromAst } from "./analysis"

const parser = remark().use(remarkDirective)

function analyze(cache: ChunkAstCache, text: string) {
  const chunks = splitChunks(text)
  const hashes = chunks.map(chunk => hashChunk(chunk.text))
  cache.retain(new Set(hashes))
  const asts = chunks.map((chunk, i) =>
    cache.get(hashes[i], chunk.text)
  )
  const shifted = asts.map((ast, i) =>
    shiftPositions(ast, chunks[i].offset, chunks[i].lineOffset)
  )
  return { asts, ast: mergeChunkAsts(shifted) }
}

describe("ChunkAstCache", () => {
  test("append-only streaming retains only current chunk ASTs", () => {
    let parses = 0
    const cache = new ChunkAstCache(text => {
      parses++
      return parser.parse(text)
    })
    const header = "---\ninterlocutor:\n  name: Bot\n---\nUser prompt"
    const history = ":::Bot\nEarlier reply\n:::"
    const payload = "<results>" + "A".repeat(32 * 1024) + "</results>"
    let text = `${header}\n${history}\n:::Bot\n${payload}\n`
    const first = analyze(cache, text)
    expect(cache.size).toBe(3)

    // No user edits: only append output to the open assistant block.
    for (let i = 0; i < 80; i++) {
      text += `More streamed output ${i}\n`
      const current = analyze(cache, text)
      expect(cache.size).toBe(3)
      expect(current.asts[0]).toBe(first.asts[0])
      expect(current.asts[1]).toBe(first.asts[1])
      expect(current.asts[2]).not.toBe(first.asts[2])
    }
    expect(parses).toBe(83)

    text += ":goal[finished]\n:::"
    const final = analyze(cache, text)
    expect(cache.size).toBe(3)
    expect(final.asts[0]).toBe(first.asts[0])
    expect(final.asts[1]).toBe(first.asts[1])
    const uri = "file:///stream.lec"
    const bundle = buildBundleFromAst(final.ast, text, uri, 1)
    const full = buildBundleFromAst(parser.parse(text), text, uri, 1)
    expect(bundle).toEqual(full)
  })

  test("completed blocks stay reusable as new blocks are appended", () => {
    const cache = new ChunkAstCache(text => parser.parse(text))
    let text = "User prompt\n:::Bot\nFirst reply\n:::"
    const first = analyze(cache, text)

    text += "\n:::Bot\nSecond reply"
    const next = analyze(cache, text)
    expect(cache.size).toBe(3)
    expect(next.asts[0]).toBe(first.asts[0])
    expect(next.asts[1]).toBe(first.asts[1])

    const completed = analyze(cache, text + "\n:::")
    expect(cache.size).toBe(3)
    expect(completed.asts[1]).toBe(first.asts[1])
  })

  test("identical chunks share an unshifted cache entry", () => {
    const cache = new ChunkAstCache(text => parser.parse(text))
    const chunk = ":::Bot\nRepeated reply\n:::"
    const result = analyze(cache, `${chunk}\n${chunk}`)
    expect(cache.size).toBe(1)
    expect(result.asts[0]).toBe(result.asts[1])
    expect(result.asts[0].position?.start.offset).toBe(0)
    expect(result.ast.children[1].position?.start.offset)
      .toBe(chunk.length + 1)
  })

  test("removed chunks are evicted and an empty document clears the cache",
    () => {
      const cache = new ChunkAstCache(text => parser.parse(text))
      analyze(cache, "User prompt\n:::Bot\nReply\n:::")
      expect(cache.size).toBe(2)
      analyze(cache, "User prompt")
      expect(cache.size).toBe(1)
      analyze(cache, "")
      expect(cache.size).toBe(0)
    })

  test("a parse failure does not retain obsolete versions", () => {
    const cache = new ChunkAstCache(text => {
      if (text === "bad") throw new Error("parse failed")
      return parser.parse(text)
    })
    analyze(cache, "old version")
    expect(cache.size).toBe(1)
    expect(() => analyze(cache, "bad")).toThrow("parse failed")
    expect(cache.size).toBe(0)
    analyze(cache, "recovered")
    expect(cache.size).toBe(1)
  })
})
