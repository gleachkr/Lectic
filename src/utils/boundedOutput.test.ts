import { describe, expect, it } from "bun:test"

import {
  allocateOutputBudgets,
  BoundedTextCollector,
} from "./boundedOutput"

describe("BoundedTextCollector", () => {
  it("retains the head and tail across chunks", () => {
    const collector = new BoundedTextCollector(5)
    collector.append("abc")
    collector.append("defghij")

    expect(collector.render(5)).toEqual({
      text: "abcij",
      truncated: true,
      originalCharacters: 10,
      returnedCharacters: 5,
      originalLines: 1,
      returnedLines: 1,
      headCharacters: 3,
      tailCharacters: 2,
    })
  })

  it("counts Unicode code points rather than UTF-16 code units", () => {
    const collector = new BoundedTextCollector(5)
    collector.append("ab😀")
    collector.append("cdef")

    const result = collector.render(5)
    expect(result.text).toBe("ab😀ef")
    expect(result.originalCharacters).toBe(7)
    expect(result.returnedCharacters).toBe(5)
  })

  it("can render a smaller view of output retained in full", () => {
    const collector = new BoundedTextCollector(10)
    collector.append("abcdefgh")

    const result = collector.render(4)
    expect(result.text).toBe("abgh")
    expect(result.headCharacters).toBe(2)
    expect(result.tailCharacters).toBe(2)
  })
})

describe("allocateOutputBudgets", () => {
  it("reserves one quarter of a contested budget for stderr", () => {
    expect(allocateOutputBudgets(20, 100, 100)).toEqual({
      stdout: 15,
      stderr: 5,
    })
  })

  it("returns unused stderr capacity to stdout", () => {
    expect(allocateOutputBudgets(20, 100, 2)).toEqual({
      stdout: 18,
      stderr: 2,
    })
  })

  it("gives stderr unused stdout capacity", () => {
    expect(allocateOutputBudgets(20, 3, 100)).toEqual({
      stdout: 3,
      stderr: 17,
    })
  })
})
