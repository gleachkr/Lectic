import { describe, test, expect } from "bun:test"
import { normalizeUrl } from "./path"
import { join } from "path"

describe("normalizeUrl", () => {
  test("expands ~ at start of path", () => {
    const home = process.env["HOME"] || "/home/user"
    const res = normalizeUrl("~/foo/bar.txt", "/tmp")
    expect(res.fsPath).toBe(join(home, "foo/bar.txt"))
    expect(res.kind).toBe("file")
  })

  test("does not expand ~ in middle of path", () => {
    const res = normalizeUrl("foo/~/bar.txt", "/tmp")
    // Should be resolved relative to docDir
    expect(res.fsPath).toBe(join("/tmp", "foo/~/bar.txt"))
  })

  test("expands env vars and ~", () => {
    const home = process.env["HOME"] || "/home/user"
    process.env["TEST_VAR"] = "baz"
    const res = normalizeUrl("~/$TEST_VAR/bar.txt", "/tmp")
    expect(res.fsPath).toBe(join(home, "baz/bar.txt"))
  })
})
