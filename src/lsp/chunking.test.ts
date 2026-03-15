import { describe, test, expect } from "bun:test"
import { splitChunks, shiftPositions, mergeChunkAsts, hashChunk } from "./chunking"
import { remark } from "remark"
import remarkDirective from "remark-directive"
import { buildBundleFromAst } from "./analysis"

const parser = remark().use(remarkDirective)

// ── splitChunks ─────────────────────────────────────────────────────

describe("splitChunks", () => {
  test("no directives → single chunk", () => {
    const text = "Hello world\nSecond line"
    const chunks = splitChunks(text)
    expect(chunks).toHaveLength(1)
    expect(chunks[0].text).toBe(text)
    expect(chunks[0].offset).toBe(0)
    expect(chunks[0].lineOffset).toBe(0)
  })

  test("header + single directive", () => {
    const text = "---\ntitle: test\n---\nUser text\n:::Assistant\nHello\n:::"
    const chunks = splitChunks(text)
    expect(chunks).toHaveLength(2)
    expect(chunks[0].text).toBe("---\ntitle: test\n---\nUser text")
    expect(chunks[0].lineOffset).toBe(0)
    expect(chunks[1].text).toBe(":::Assistant\nHello\n:::")
    expect(chunks[1].lineOffset).toBe(4)
  })

  test("multiple directives", () => {
    const text = "Header\n:::A\nBlock A\n:::\nMiddle\n:::B\nBlock B\n:::\nEnd"
    const chunks = splitChunks(text)
    expect(chunks).toHaveLength(5)
    expect(chunks[0].text).toBe("Header")
    expect(chunks[1].text).toBe(":::A\nBlock A\n:::")
    expect(chunks[1].lineOffset).toBe(1)
    expect(chunks[2].text).toBe("Middle")
    expect(chunks[2].lineOffset).toBe(4)
    expect(chunks[3].text).toBe(":::B\nBlock B\n:::")
    expect(chunks[3].lineOffset).toBe(5)
    expect(chunks[4].text).toBe("End")
    expect(chunks[4].lineOffset).toBe(8)
  })

  test("adjacent directives (no gap)", () => {
    const text = ":::A\nContent A\n:::\n:::B\nContent B\n:::"
    const chunks = splitChunks(text)
    expect(chunks).toHaveLength(2)
    expect(chunks[0].text).toBe(":::A\nContent A\n:::")
    expect(chunks[1].text).toBe(":::B\nContent B\n:::")
  })

  test("empty text between directives is omitted", () => {
    const text = ":::A\nX\n:::\n:::B\nY\n:::"
    const chunks = splitChunks(text)
    // No empty chunk between the two directives
    for (const chunk of chunks) {
      expect(chunk.text.length).toBeGreaterThan(0)
    }
  })

  test("closing ::: with trailing whitespace", () => {
    const text = ":::A\nContent\n:::   \nAfter"
    const chunks = splitChunks(text)
    expect(chunks).toHaveLength(2)
    expect(chunks[0].text).toBe(":::A\nContent\n:::   ")
  })

  test("offsets are correct", () => {
    const text = "AB\n:::X\nCD\n:::\nEF"
    const chunks = splitChunks(text)
    // "AB\n" = 3 chars → directive starts at offset 3
    expect(chunks[0].text).toBe("AB")
    expect(chunks[0].offset).toBe(0)
    expect(chunks[1].text).toBe(":::X\nCD\n:::")
    expect(chunks[1].offset).toBe(3)
    // ":::X\nCD\n:::\n" = 12 chars → "EF" starts at offset 15
    expect(chunks[2].text).toBe("EF")
    expect(chunks[2].offset).toBe(15)
  })
})

// ── hashChunk ───────────────────────────────────────────────────────

describe("hashChunk", () => {
  test("same text produces same hash", () => {
    expect(hashChunk("hello")).toBe(hashChunk("hello"))
  })

  test("different text produces different hash", () => {
    expect(hashChunk("hello")).not.toBe(hashChunk("world"))
  })
})

// ── shiftPositions ──────────────────────────────────────────────────

describe("shiftPositions", () => {
  test("shifts offsets and line numbers", () => {
    const ast = parser.parse("Hello\nWorld")
    const shifted = shiftPositions(ast, 100, 10)
    const firstChild = shifted.children[0]
    expect(firstChild.position!.start.offset).toBe(100)
    expect(firstChild.position!.start.line).toBe(11) // 1 + 10
    expect(firstChild.position!.start.column).toBe(1) // unchanged
  })

  test("zero offset returns same object", () => {
    const ast = parser.parse("Hello")
    const shifted = shiftPositions(ast, 0, 0)
    expect(shifted).toBe(ast) // same reference, no clone
  })

  test("does not mutate original", () => {
    const ast = parser.parse("Hello")
    const origOffset = ast.children[0].position!.start.offset
    shiftPositions(ast, 50, 5)
    expect(ast.children[0].position!.start.offset).toBe(origOffset)
  })
})

// ── Round-trip: split → parse → shift → merge ──────────────────────

function chunkedBundle(text: string) {
  const chunks = splitChunks(text)
  const shifted = chunks.map(c =>
    shiftPositions(parser.parse(c.text), c.offset, c.lineOffset)
  )
  return buildBundleFromAst(mergeChunkAsts(shifted), text, "file:///test.lec", 1)
}

function fullBundle(text: string) {
  return buildBundleFromAst(parser.parse(text), text, "file:///test.lec", 1)
}

describe("round-trip chunked parse", () => {
  test("chunked parse matches full parse for bundle extraction", () => {
    const text = [
      "---",
      "interlocutor:",
      "  name: Assistant",
      "---",
      "User message here",
      "",
      ":::Assistant",
      "Hello from assistant",
      ":::",
      "",
      "More user text",
      "",
    ].join("\n")

    const full = fullBundle(text)
    const chunked = chunkedBundle(text)
    expect(chunked.blocks).toEqual(full.blocks)
    expect(chunked.directives).toEqual(full.directives)
    expect(chunked.headerOffset).toBe(full.headerOffset)
  })

  test("chunked parse matches full parse with multiple assistants", () => {
    const text = [
      "---",
      "interlocutor:",
      "  name: Bot",
      "---",
      "First user turn",
      "",
      ":::Bot",
      "First reply",
      ":::",
      "",
      "Second user turn",
      "",
      ":::Bot",
      "Second reply with :directive[arg]",
      ":::",
      "",
    ].join("\n")

    const full = fullBundle(text)
    const chunked = chunkedBundle(text)
    expect(chunked.blocks).toEqual(full.blocks)
    expect(chunked.directives).toEqual(full.directives)
  })

  test("chunked parse matches full parse with tool calls", () => {
    const text = [
      "---",
      "interlocutor:",
      "  name: Assistant",
      "  prompt: hi",
      "---",
      "Before",
      "",
      ":::Assistant",
      '<tool-call with="search" kind="exec">',
      "<arguments></arguments>",
      "<results></results>",
      "</tool-call>",
      ":::",
      "",
      "After",
      "",
    ].join("\n")

    const full = fullBundle(text)
    const chunked = chunkedBundle(text)
    expect(chunked.blocks).toEqual(full.blocks)
    expect(chunked.toolCallBlocks).toEqual(full.toolCallBlocks)
  })
})
