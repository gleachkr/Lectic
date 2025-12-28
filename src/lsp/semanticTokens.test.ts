import { describe, test, expect } from "bun:test"
import { buildBundle } from "./analysis"
import { buildSemanticTokens } from "./semanticTokens"

describe("Semantic Tokens", () => {
  test("plain directives are highlighted", () => {
    const text = "Hello :example world"
    const bundle = buildBundle(text)
    const tokens = buildSemanticTokens(text, bundle)
    
    // tokens.data is delta-encoded
    // [lineDelta, charDelta, length, typeIndex, mods]
    // ":example" starts at line 0, char 6, length 8
    expect(tokens.data).toEqual([0, 6, 8, 0, 0])
  })

  test("directives with attributes but no brackets", () => {
    const text = "Hello :example{a=b} world"
    const bundle = buildBundle(text)
    const tokens = buildSemanticTokens(text, bundle)
    
    // ":example{a=b}" line 0, char 6, length 13
    expect(tokens.data).toEqual([0, 6, 13, 0, 0])
  })

  test("directives with brackets are highlighted", () => {
    const text = "Hello :example[content] world"
    const bundle = buildBundle(text)
    const tokens = buildSemanticTokens(text, bundle)
    
    // ":example[" starts at line 0, char 6, length 9
    // "]" starts at line 0, char 22 (6 + 8 + 1 + 7), length 1
    // Delta-encoded:
    // [0, 6, 9, 0, 0] (first token)
    // [0, 16, 1, 0, 0] (second token: lineDelta=0, charDelta=22-6=16, length=1)
    
    expect(tokens.data).toEqual([
      0, 6, 9, 0, 0,
      0, 16, 1, 0, 0
    ])
  })

  test("multiple directives", () => {
    const text = ":one\n:two[]"
    const bundle = buildBundle(text)
    const tokens = buildSemanticTokens(text, bundle)
    
    // ":one" line 0, char 0, length 4
    // ":two[" line 1, char 0, length 5
    // "]" line 1, char 5, length 1
    
    expect(tokens.data).toEqual([
      0, 0, 4, 0, 0, // :one
      1, 0, 5, 0, 0, // :two[
      0, 5, 1, 0, 0  // ]
    ])
  })
})
