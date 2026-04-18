import { describe, expect, test } from "bun:test"

import {
  presentRunProgressEnd,
  presentToolApproval,
  presentToolProgressEnd,
  presentToolProgressStart,
} from "./presentation"

describe("editor presentation helpers", () => {
  test("formats argv progress as a shell command preview", () => {
    const result = presentToolProgressStart(
      "shell",
      JSON.stringify({
        argv: ["git", "diff", "--cached", "--stat"],
      })
    )

    expect(result).toEqual({
      title: "Running shell",
      message: "git diff --cached --stat",
    })
  })

  test("formats approval prompts as structured text", () => {
    const result = presentToolApproval(
      "shell",
      JSON.stringify({
        argv: ["git", "diff", "--cached"],
      })
    )

    expect(result.title).toBe("Allow shell?")
    expect(result.severity).toBe("warning")
    expect(result.message).toContain("Tool: shell")
    expect(result.message).toContain("git diff --cached")
  })

  test("formats failure summaries with duration and error text", () => {
    const result = presentToolProgressEnd(
      "sqlite",
      JSON.stringify({ message: "syntax error near FROM" }),
      "1530"
    )

    expect(result.message).toBe(
      "Failed: sqlite · 1.5 s · syntax error near FROM"
    )
  })

  test("formats run completion summaries", () => {
    const result = presentRunProgressEnd("success", undefined, "420")
    expect(result.message).toBe("Run complete · 420 ms")
  })
})
