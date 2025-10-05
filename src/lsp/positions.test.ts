import { describe, test, expect } from "bun:test"
import { offsetToPosition, positionToOffset } from "./positions"

function crlf(s: string): string { return s.replace(/\n/g, "\r\n") }

describe("positions", () => {
  test("offsetToPosition and positionToOffset roundtrip on LF", () => {
    const text = "ab\ncd\nef\n"
    for (let off = 0; off <= text.length; off++) {
      const pos = offsetToPosition(text, off)
      const back = positionToOffset(text, pos)
      const pos2 = offsetToPosition(text, back)
      expect(pos2.line).toBe(pos.line)
      expect(pos2.character).toBe(pos.character)
    }
  })

  test("offsetToPosition and positionToOffset roundtrip on CRLF", () => {
    const text = crlf("ab\ncd\nef\n")
    for (let off = 0; off <= text.length; off++) {
      const pos = offsetToPosition(text, off)
      const back = positionToOffset(text, pos)
      const pos2 = offsetToPosition(text, back)
      expect(pos2.line).toBe(pos.line)
      expect(pos2.character).toBe(pos.character)
    }
  })
})
