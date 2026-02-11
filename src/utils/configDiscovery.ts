import { stat } from "fs/promises"
import { dirname, isAbsolute, join, normalize, resolve } from "path"

import * as YAML from "yaml"

import { rewriteLocalInNode } from "./localPath"
import { expandEnv } from "./replace"
import { lecticConfigDir } from "./xdg"

export type ConfigSourceKind =
  | "system"
  | "workspace"
  | "document"
  | "import"

export type ConfigIssuePhase = "read" | "parse" | "import"

export type ConfigResolutionIssue = {
  source: ConfigSourceKind
  phase: ConfigIssuePhase
  message: string
  id: string
}

export type ResolvedConfigSource = {
  source: ConfigSourceKind
  id: string
  path?: string
  text: string
  parsed: unknown | null
}

export type ResolveConfigChainOptions = {
  includeSystem?: boolean
  workspaceStartDir?: string
  document?: {
    yaml: string | null
    dir?: string
  }
}

type ImportRef = {
  path: string
  optional: boolean
}

export async function findWorkspaceConfigPath(
  startDir: string
): Promise<string | null> {
  let dir = startDir
  while (true) {
    const candidate = join(dir, "lectic.yaml")
    try {
      await Bun.file(candidate).text()
      return candidate
    } catch {
      const parent = dirname(dir)
      if (parent === dir) return null
      dir = parent
    }
  }
}

function parseImportRefs(
  parsed: unknown,
  source: ConfigSourceKind,
  id: string,
  baseDir: string | undefined,
  issues: ConfigResolutionIssue[]
): ImportRef[] {
  if (typeof parsed !== "object" || parsed === null) return []

  const maybeImports = (parsed as { imports?: unknown }).imports
  if (maybeImports === undefined) return []

  if (!Array.isArray(maybeImports)) {
    issues.push({
      source,
      phase: "import",
      id,
      message: "imports must be a list",
    })
    return []
  }

  const out: ImportRef[] = []

  for (const item of maybeImports) {
    let rawPath: string | undefined
    let optional = false

    if (typeof item === "string") {
      rawPath = item
    } else if (typeof item === "object" && item !== null) {
      const rec = item as { path?: unknown, optional?: unknown }
      if (typeof rec.path === "string") {
        rawPath = rec.path
      }
      if (typeof rec.optional === "boolean") {
        optional = rec.optional
      }
    }

    if (typeof rawPath !== "string") {
      issues.push({
        source,
        phase: "import",
        id,
        message:
          "each import must be a string or an object with " +
          "a string path",
      })
      continue
    }

    const expanded = expandEnv(rawPath.trim())
    if (!expanded) {
      issues.push({
        source,
        phase: "import",
        id,
        message: "import path cannot be empty",
      })
      continue
    }

    if (!isAbsolute(expanded) && !baseDir) {
      issues.push({
        source,
        phase: "import",
        id,
        message:
          `cannot resolve relative import ${JSON.stringify(expanded)} ` +
          "without a base directory",
      })
      continue
    }

    const resolvedPath = isAbsolute(expanded)
      ? normalize(expanded)
      : normalize(resolve(baseDir ?? ".", expanded))

    out.push({ path: resolvedPath, optional })
  }

  return out
}

async function maybeDirectoryConfigPath(path: string): Promise<string> {
  try {
    const st = await stat(path)
    if (st.isDirectory()) {
      return normalize(join(path, "lectic.yaml"))
    }
  } catch {
    // Keep the original path. Read errors are handled at the call-site.
  }

  return normalize(path)
}

export async function resolveConfigChain(
  opts: ResolveConfigChainOptions
): Promise<{
  sources: ResolvedConfigSource[]
  issues: ConfigResolutionIssue[]
}> {
  const sources: ResolvedConfigSource[] = []
  const issues: ConfigResolutionIssue[] = []

  const seen = new Set<string>()
  const active = new Set<string>()

  const visitFile = async (
    path: string,
    source: ConfigSourceKind,
    optional: boolean,
    fromId: string
  ) => {
    const id = await maybeDirectoryConfigPath(path)

    if (active.has(id)) {
      issues.push({
        source,
        phase: "import",
        id,
        message: `import cycle detected while resolving from ${fromId}`,
      })
      return
    }

    if (seen.has(id)) return

    let text: string
    try {
      text = await Bun.file(id).text()
    } catch (e) {
      if (optional) return
      const message = e instanceof Error ? e.message : String(e)
      issues.push({
        source,
        phase: "read",
        id,
        message,
      })
      return
    }

    seen.add(id)
    active.add(id)

    let parsed: unknown | null = null
    let resolvedText = text
    let canResolveImports = true
    let parsedSuccessfully = false

    try {
      const parsedValue = YAML.parse(text)
      parsedSuccessfully = true
      const rewritten = rewriteLocalInNode(parsedValue, dirname(id))
      parsed = rewritten

      if (rewritten !== parsedValue) {
        resolvedText = YAML.stringify(rewritten)
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      if (!parsedSuccessfully) {
        issues.push({
          source,
          phase: "parse",
          id,
          message,
        })
      } else {
        issues.push({
          source,
          phase: "import",
          id,
          message,
        })
        canResolveImports = false
      }
    }

    try {
      if (canResolveImports) {
        const refs = parseImportRefs(
          parsed,
          source,
          id,
          dirname(id),
          issues
        )
        for (const ref of refs) {
          await visitFile(ref.path, "import", ref.optional, id)
        }
      }
    } finally {
      active.delete(id)
    }

    sources.push({
      source,
      id,
      path: id,
      text: resolvedText,
      parsed,
    })
  }

  if (opts.includeSystem ?? true) {
    const systemPath = join(lecticConfigDir(), "lectic.yaml")
    await visitFile(systemPath, "system", true, "<root>")
  }

  if (opts.workspaceStartDir) {
    const workspacePath = await findWorkspaceConfigPath(opts.workspaceStartDir)
    if (workspacePath) {
      await visitFile(workspacePath, "workspace", true, "<root>")
    }
  }

  const docYaml = opts.document?.yaml
  if (typeof docYaml === "string" && docYaml.length > 0) {
    const id = "<document>"
    let parsed: unknown | null = null
    let resolvedText = docYaml
    let canResolveImports = true
    let parsedSuccessfully = false

    try {
      const parsedValue = YAML.parse(docYaml)
      parsedSuccessfully = true
      const rewritten = rewriteLocalInNode(parsedValue, opts.document?.dir)
      parsed = rewritten

      if (rewritten !== parsedValue) {
        resolvedText = YAML.stringify(rewritten)
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      if (!parsedSuccessfully) {
        issues.push({
          source: "document",
          phase: "parse",
          id,
          message,
        })
      } else {
        issues.push({
          source: "document",
          phase: "import",
          id,
          message,
        })
        canResolveImports = false
      }
    }

    if (canResolveImports) {
      const refs = parseImportRefs(
        parsed,
        "document",
        id,
        opts.document?.dir,
        issues
      )
      for (const ref of refs) {
        await visitFile(ref.path, "import", ref.optional, id)
      }
    }

    sources.push({
      source: "document",
      id,
      text: resolvedText,
      parsed,
    })
  }

  return { sources, issues }
}

export function formatConfigResolutionIssue(
  issue: ConfigResolutionIssue
): string {
  const where =
    issue.source === "document"
      ? "document header"
      : `${issue.source} config (${issue.id})`

  if (issue.phase === "parse") {
    return `Error parsing ${where}: ${issue.message}`
  }

  if (issue.phase === "read") {
    return `Error reading ${where}: ${issue.message}`
  }

  return `Error resolving imports in ${where}: ${issue.message}`
}
