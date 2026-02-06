import type { AnalysisBundle } from "../analysisTypes"
import { buildBundle } from "../analysis"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"

let isolatedConfig: { dir: string, prev: string | undefined } | null = null

function ensureIsolatedSystemConfig() {
  if (process.env["LECTIC_TEST_USE_EXISTING_CONFIG"] === "1") return
  if (isolatedConfig) return

  const dir = mkdtempSync(join(tmpdir(), "lectic-test-config-"))
  mkdirSync(dir, { recursive: true })

  const lecticYaml = join(dir, "lectic.yaml")
  const contents = [
    "interlocutor:",
    "  name: Main",
    "  prompt: hi",
    "",
  ].join("\n")

  writeFileSync(lecticYaml, contents)

  isolatedConfig = { dir, prev: process.env["LECTIC_CONFIG"] }
  process.env["LECTIC_CONFIG"] = dir

  process.on("exit", () => {
    try {
      if (isolatedConfig?.prev === undefined) {
        delete process.env["LECTIC_CONFIG"]
      } else {
        process.env["LECTIC_CONFIG"] = isolatedConfig.prev
      }
    } catch {
      // ignore
    }

    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // ignore
    }
  })
}

export function buildTestBundle(
  docText: string,
  uri = "file:///doc.lec",
  version = 1
): AnalysisBundle {
  ensureIsolatedSystemConfig()
  return buildBundle(docText, uri, version)
}
