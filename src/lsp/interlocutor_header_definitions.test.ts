import { describe, test, expect } from "bun:test"
import { mkdtempSync, writeFileSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { resolveDefinition } from "./definitions"

describe("interlocutor header definitions", () => {
  test("jump from local interlocutor name to inherited definition in workspace", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lectic-header-def-"))
    try {
      // workspace lectic.yaml with interlocutor Assistant
      const wsYaml = "interlocutor:\n  name: Assistant\n  prompt: baseline\n"
      writeFileSync(join(dir, "lectic.yaml"), wsYaml)

      // local file overriding Assistant
      const lec = "---\ninterlocutor:\n  name: Assistant\n  prompt: override\n---\n"
      const path = join(dir, "doc.lec")
      writeFileSync(path, lec)
      const uri = `file://${path}`

      // Position of 'Assistant' in the local file
      // ---
      // interlocutor:
      //   name: Assistant
      //         ^ line 2, char 8
      const pos = { line: 2, character: 8 } as any

      const locs = await resolveDefinition(uri, lec, pos)
      expect(Array.isArray(locs)).toBeTrue()
      if (Array.isArray(locs)) {
        expect(locs.length).toBe(1)
        // Should skip local and return only workspace
        expect(locs[0].uri).toBe(`file://${join(dir, "lectic.yaml")}`)
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("jump from agent target in header to definition", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lectic-header-agent-"))
    try {
      const wsYaml = "interlocutors:\n  - name: Researcher\n    prompt: hi\n"
      writeFileSync(join(dir, "lectic.yaml"), wsYaml)

      const lec = "---\ninterlocutor:\n  name: Boss\n  tools:\n    - agent: Researcher\n---\n"
      const path = join(dir, "doc.lec")
      writeFileSync(path, lec)
      const uri = `file://${path}`

      // Position of 'Researcher' in the local file
      // ---
      // interlocutor:
      //   name: Boss
      //   tools:
      //     - agent: Researcher
      //              ^ line 4, char 13
      const pos = { line: 4, character: 13 } as any

      const locs = await resolveDefinition(uri, lec, pos)
      expect(Array.isArray(locs)).toBeTrue()
      if (Array.isArray(locs)) {
        expect(locs.length).toBe(1)
        expect(locs[0].uri).toBe(`file://${join(dir, "lectic.yaml")}`)
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("jump from local macro name to inherited definition", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lectic-macro-header-def-"))
    try {
      const wsYaml = "macros:\n  - name: plan\n    expansion: base\n"
      writeFileSync(join(dir, "lectic.yaml"), wsYaml)

      const lec = "---\nmacros:\n  - name: plan\n    expansion: local\n---\n"
      const path = join(dir, "doc.lec")
      writeFileSync(path, lec)
      const uri = `file://${path}`

      // Position of 'plan' in the local file
      // ---
      // macros:
      //   - name: plan
      //           ^ line 2, char 10
      const pos = { line: 2, character: 10 } as any

      const locs = await resolveDefinition(uri, lec, pos)
      expect(Array.isArray(locs)).toBeTrue()
      if (Array.isArray(locs)) {
        expect(locs.length).toBe(1)
        expect(locs[0].uri).toBe(`file://${join(dir, "lectic.yaml")}`)
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
