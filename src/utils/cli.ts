import { dirname } from "path"

import { type OptionValues } from "commander"

import {
  formatConfigResolutionIssue,
  resolveConfigChain,
} from "./configDiscovery"
import { lecticEnv } from "./xdg"

export async function getLecticString(opts : OptionValues) : Promise<string> {
    if (opts["inplace"] || opts["file"]) {
        const path = opts["inplace"] || opts["file"]
        const fileText = await Bun.file(path).text()
        const pipeText = process.stdin.isTTY 
            ? "" 
            : `\n\n${await Bun.stdin.text()}` 
        return fileText + pipeText
    } else {
        return Bun.stdin.text()
    }
}

export async function getIncludes(
  documentYaml: string | null = null,
  documentDir?: string,
  workspaceStartDir?: string
): Promise<(string | null)[]> {
  const startDir = workspaceStartDir ?? (
    lecticEnv["LECTIC_FILE"]
      ? dirname(lecticEnv["LECTIC_FILE"])
      : process.cwd()
  )

  const { sources, issues } = await resolveConfigChain({
    includeSystem: true,
    workspaceStartDir: startDir,
    document:
      documentYaml !== null
        ? { yaml: documentYaml, dir: documentDir ?? startDir }
        : undefined,
  })

  if (issues.length > 0) {
    const message = issues.map(formatConfigResolutionIssue).join("\n")
    throw new Error(message)
  }

  return sources
    .filter(source => source.source !== "document")
    .map(source => source.text)
}
