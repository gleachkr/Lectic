import { computeReplaceRange, findSingleColonStart } from "./server"
import { describe, test, expect } from "bun:test"

describe("server helpers", () => {
  test("findSingleColonStart accepts single : only", () => {
    expect(findSingleColonStart(":", 1)).toBe(0)
    expect(findSingleColonStart("x:", 2)).toBe(1)
    // allows prefix after ':'
    expect(findSingleColonStart(":su", 3)).toBe(0)
    expect(findSingleColonStart("::", 2)).toBeNull()
    expect(findSingleColonStart(":::", 3)).toBeNull()
    expect(findSingleColonStart("abc::def", 5)).toBeNull()
  })

  test("computeReplaceRange spans from : to cursor", () => {
    const r = computeReplaceRange(2, 4, 7)
    expect(r.start.line).toBe(2)
    expect(r.start.character).toBe(4)
    expect(r.end.line).toBe(2)
    expect(r.end.character).toBe(7)
  })
})
