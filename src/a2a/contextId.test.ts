import { describe, expect, test } from "bun:test"
import {
  A2A_CONTEXT_ID_RE,
  isValidA2AContextId,
  resolveA2AContextId,
} from "./contextId"

describe("A2A contextId validation", () => {
  test("accepts valid ids", () => {
    const ids = [
      "a",
      "A",
      "0",
      "abc",
      "abc-123_DEF.456",
      "a".repeat(128),
    ]

    for (const id of ids) {
      expect(isValidA2AContextId(id)).toBe(true)
      expect(A2A_CONTEXT_ID_RE.test(id)).toBe(true)
    }
  })

  test("rejects invalid ids", () => {
    const ids = [
      "",
      "-bad",
      ".bad",
      "bad!",
      "has space",
      "a".repeat(129),
    ]

    for (const id of ids) {
      expect(isValidA2AContextId(id)).toBe(false)
      expect(() => resolveA2AContextId(id)).toThrow()
    }
  })

  test("generates id when missing", () => {
    const a = resolveA2AContextId(undefined)
    const b = resolveA2AContextId(null)
    expect(isValidA2AContextId(a)).toBe(true)
    expect(isValidA2AContextId(b)).toBe(true)
  })
})
