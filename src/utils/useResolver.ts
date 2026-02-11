import { isObjectRecord } from "../types/guards"
import { type HookSpec, validateHookSpec } from "../types/hook"

type UseRef = { use: string }

type DefMaps = {
  hooks: Map<string, HookSpec>
  envs: Map<string, Record<string, string>>
  sandboxes: Map<string, string>
}

function asUseRef(value: unknown): UseRef | null {
  if (!isObjectRecord(value)) return null
  const keys = Object.keys(value)
  if (keys.length !== 1 || keys[0] !== "use") return null

  const use = value["use"]
  if (typeof use !== "string" || use.length === 0) return null
  return { use }
}

function cloneEnv(env: Record<string, string>): Record<string, string> {
  return { ...env }
}

function getDef<T>(
  defs: Map<string, T>,
  name: string,
  kind: string
): T {
  const found = defs.get(name)
  if (found === undefined) {
    throw new Error(`Unknown ${kind} definition: ${name}`)
  }
  return found
}

function collectHookDefs(raw: unknown): Map<string, HookSpec> {
  const defs = new Map<string, HookSpec>()
  if (raw === undefined) return defs

  if (!Array.isArray(raw)) {
    throw new Error("hook_defs must be a list")
  }

  for (const entry of raw) {
    if (!isObjectRecord(entry) || typeof entry["name"] !== "string") {
      throw new Error("each hook_def must have a string name")
    }

    const def = { ...entry }
    validateHookSpec(def)
    defs.set(entry["name"], def as HookSpec)
  }

  return defs
}

function collectEnvDefs(raw: unknown): Map<string, Record<string, string>> {
  const defs = new Map<string, Record<string, string>>()
  if (raw === undefined) return defs

  if (!Array.isArray(raw)) {
    throw new Error("env_defs must be a list")
  }

  for (const entry of raw) {
    if (!isObjectRecord(entry) || typeof entry["name"] !== "string") {
      throw new Error("each env_def must have a string name")
    }

    const env = entry["env"]
    if (!isObjectRecord(env)) {
      throw new Error(
        `env_def ${entry["name"]} must define an env object`
      )
    }

    const out: Record<string, string> = {}
    for (const [key, value] of Object.entries(env)) {
      if (typeof value !== "string") {
        throw new Error(
          `env_def ${entry["name"]} contains non-string env value`
        )
      }
      out[key] = value
    }

    defs.set(entry["name"], out)
  }

  return defs
}

function collectSandboxDefs(raw: unknown): Map<string, string> {
  const defs = new Map<string, string>()
  if (raw === undefined) return defs

  if (!Array.isArray(raw)) {
    throw new Error("sandbox_defs must be a list")
  }

  for (const entry of raw) {
    if (!isObjectRecord(entry) || typeof entry["name"] !== "string") {
      throw new Error("each sandbox_def must have a string name")
    }

    if (typeof entry["sandbox"] !== "string") {
      throw new Error(
        `sandbox_def ${entry["name"]} must define sandbox string`
      )
    }

    defs.set(entry["name"], entry["sandbox"])
  }

  return defs
}

function resolveHookEntries(entries: unknown[], defs: DefMaps): unknown[] {
  return entries.map(entry => {
    const ref = asUseRef(entry)
    const source = ref
      ? getDef(defs.hooks, ref.use, "hook")
      : entry
    return rewriteNode(source, defs)
  })
}

function rewriteNode(node: unknown, defs: DefMaps): unknown {
  if (Array.isArray(node)) {
    return node.map(item => rewriteNode(item, defs))
  }

  if (!isObjectRecord(node)) return node

  const out: Record<string, unknown> = {}

  for (const [key, value] of Object.entries(node)) {
    if (key === "hooks" && Array.isArray(value)) {
      out[key] = resolveHookEntries(value, defs)
      continue
    }

    if (key === "env") {
      const ref = asUseRef(value)
      out[key] = ref
        ? cloneEnv(getDef(defs.envs, ref.use, "env"))
        : value
      continue
    }

    if (key === "sandbox") {
      const ref = asUseRef(value)
      out[key] = ref
        ? getDef(defs.sandboxes, ref.use, "sandbox")
        : value
      continue
    }

    out[key] = rewriteNode(value, defs)
  }

  return out
}

export function resolveNamedUses(raw: unknown): unknown {
  if (!isObjectRecord(raw)) return raw

  const defs: DefMaps = {
    hooks: collectHookDefs(raw["hook_defs"]),
    envs: collectEnvDefs(raw["env_defs"]),
    sandboxes: collectSandboxDefs(raw["sandbox_defs"]),
  }

  const withoutDefs: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(raw)) {
    if (key === "hook_defs") continue
    if (key === "env_defs") continue
    if (key === "sandbox_defs") continue
    withoutDefs[key] = value
  }

  return rewriteNode(withoutDefs, defs)
}
