import { describe, test, expect } from "bun:test"
import { mkdtempSync, writeFileSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { resolveDefinition } from "./definitions"

describe("kit header definitions", () => {
  test("jump from kit target in header to definition", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lectic-header-kit-"))
    try {
      const wsYaml = "kits:\n  - name: Tools\n    tools:\n      - exec: date\n"
      writeFileSync(join(dir, "lectic.yaml"), wsYaml)

      const lec = "---\ninterlocutor:\n  name: Boss\n  tools:\n    - kit: Tools\n---\n"
      const path = join(dir, "doc.lec")
      writeFileSync(path, lec)
      const uri = `file://${path}`

      // Position of 'Tools' in the local file
      // ---
      // interlocutor:
      //   name: Boss
      //   tools:
      //     - kit: Tools
      //            ^ line 4, char 11
      const pos = { line: 4, character: 11 } as any

      const locs = await resolveDefinition(uri, lec, pos)
      expect(Array.isArray(locs)).toBeTrue()
      if (Array.isArray(locs)) {
        expect(locs.length).toBe(1)
        expect(locs[0].uri).toBe(`file://${join(dir, "lectic.yaml")}`)
        expect(locs[0].range.start.line).toBe(1)
        expect(locs[0].range.start.character).toBe(10) // 'Tools' starts at char 10
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("jump from kit name in header to inherited definition", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lectic-kit-header-def-"))
    try {
      const wsYaml = "kits:\n  - name: Tools\n    tools:\n      - exec: date\n"
      writeFileSync(join(dir, "lectic.yaml"), wsYaml)

      const lec = "---\nkits:\n  - name: Tools\n    tools:\n      - exec: ls\n---\n"
      const path = join(dir, "doc.lec")
      writeFileSync(path, lec)
      const uri = `file://${path}`

      // Position of 'Tools' in the local file
      // ---
      // kits:
      //   - name: Tools
      //           ^ line 2, char 10
      const pos = { line: 2, character: 10 } as any

      const locs = await resolveDefinition(uri, lec, pos)
      expect(Array.isArray(locs)).toBeTrue()
      if (Array.isArray(locs)) {
        expect(locs.length).toBe(1)
        expect(locs[0].uri).toBe(`file://${join(dir, "lectic.yaml")}`)
        expect(locs[0].range.start.line).toBe(1)
        expect(locs[0].range.start.character).toBe(10)
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
