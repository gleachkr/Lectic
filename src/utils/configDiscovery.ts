import { existsSync, realpathSync, statSync } from "fs"
import { stat } from "fs/promises"
import {
  basename,
  delimiter,
  dirname,
  isAbsolute,
  join,
  normalize,
  resolve,
} from "path"

import * as YAML from "yaml"

import { rewriteLocalInNode } from "./localPath"
import { expandEnv } from "./replace"
import { lecticConfigDir, lecticDataDir } from "./xdg"

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

type SearchDir = {
  dir: string
  recursive: boolean
}

type ImportRef =
  | {
      kind: "path"
      path: string
      optional: boolean
    }
  | {
      kind: "plugin"
      plugin: string
      optional: boolean
    }

function runtimeSearchDirs(): SearchDir[] {
  const runtime = process.env["LECTIC_RUNTIME"]
  if (runtime === undefined) return []

  return runtime
    .split(delimiter)
    .map(dir => dir.trim())
    .filter(Boolean)
    .map(dir => ({ dir, recursive: true }))
}

function pluginSearchDirs(): SearchDir[] {
  return [
    ...runtimeSearchDirs(),
    { dir: lecticConfigDir(), recursive: true },
    { dir: lecticDataDir(), recursive: true },
  ]
}

function findPluginConfigsInDir(
  dir: string,
  plugin: string,
  recursive: boolean
): string[] {
  if (!existsSync(dir)) return []

  let st
  try {
    st = statSync(dir)
  } catch {
    return []
  }
  if (!st.isDirectory()) return []

  const pattern = recursive ? "**/lectic.yaml" : "*/lectic.yaml"
  const glob = new Bun.Glob(pattern)
  const found = new Set<string>()

  for (const maybePath of glob.scanSync({
    cwd: dir,
    absolute: true,
    onlyFiles: true,
    followSymlinks: true,
  })) {
    if (basename(dirname(maybePath)) !== plugin) continue

    try {
      found.add(realpathSync(maybePath))
    } catch {
      // Ignore broken symlinks or races.
    }
  }

  return [...found].sort()
}

async function resolvePluginImport(plugin: string): Promise<string | null> {
  if (plugin.includes("/") || plugin.includes("\\")) {
    throw new Error("plugin import names must not contain path separators")
  }

  for (const loc of pluginSearchDirs()) {
    const matches = findPluginConfigsInDir(loc.dir, plugin, loc.recursive)

    if (matches.length > 1) {
      throw new Error(
        `multiple plugins named '${plugin}' available:\n `
          + `${matches.join("\n")}\n`
      )
    }

    if (matches.length === 1) {
      return matches[0]
    }
  }

  return null
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
    let rawPlugin: string | undefined
    let optional = false

    if (typeof item === "string") {
      rawPath = item
    } else if (typeof item === "object" && item !== null) {
      const rec = item as {
        path?: unknown
        plugin?: unknown
        optional?: unknown
      }
      if (typeof rec.path === "string") {
        rawPath = rec.path
      }
      if (typeof rec.plugin === "string") {
        rawPlugin = rec.plugin
      }
      if (typeof rec.optional === "boolean") {
        optional = rec.optional
      }
    }

    if ((rawPath === undefined) === (rawPlugin === undefined)) {
      issues.push({
        source,
        phase: "import",
        id,
        message:
          "each import must be a string or an object with exactly " +
          "one of path or plugin",
      })
      continue
    }

    if (typeof rawPath === "string") {
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

      out.push({ kind: "path", path: resolvedPath, optional })
      continue
    }

    const plugin = expandEnv((rawPlugin ?? "").trim())
    if (!plugin) {
      issues.push({
        source,
        phase: "import",
        id,
        message: "plugin import name cannot be empty",
      })
      continue
    }

    out.push({ kind: "plugin", plugin, optional })
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
        await visitImportRefs(refs, source, id)
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

  const visitImportRefs = async (
    refs: ImportRef[],
    source: ConfigSourceKind,
    id: string
  ) => {
    for (const ref of refs) {
      if (ref.kind === "path") {
        await visitFile(ref.path, "import", ref.optional, id)
        continue
      }

      try {
        const resolved = await resolvePluginImport(ref.plugin)
        if (resolved === null) {
          if (ref.optional) continue
          issues.push({
            source,
            phase: "import",
            id,
            message:
              `plugin '${ref.plugin}' could not be found in `
                + "LECTIC_RUNTIME, LECTIC_CONFIG, or LECTIC_DATA",
          })
          continue
        }

        await visitFile(resolved, "import", ref.optional, id)
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e)
        issues.push({
          source,
          phase: "import",
          id,
          message,
        })
      }
    }
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
      await visitImportRefs(refs, "document", id)
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
