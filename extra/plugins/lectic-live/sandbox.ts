import { realpath, readdir } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { record } from "./protocol"
import { runChild, resolveLectic, type RunOptions } from "./lectic-runner"

// Exact command policy, not a heuristic that accepts any mention of bwrap.
// Expose system executables and this workspace, not the host home or /run.
export const readOnlySandbox = [
  "bwrap --unshare-all --die-with-parent --new-session",
  "--ro-bind /usr /usr --ro-bind-try /bin /bin",
  "--ro-bind-try /lib /lib --ro-bind-try /lib64 /lib64",
  "--ro-bind-try /nix/store /nix/store",
  "--proc /proc --dev /dev --tmpfs /tmp --tmpfs /run",
  '--ro-bind "$LECTIC_LIVE_WORKSPACE" "$LECTIC_LIVE_WORKSPACE"',
  '--chdir "$LECTIC_LIVE_WORKSPACE" --clearenv',
  '--setenv PATH "$PATH" --setenv HOME /tmp --setenv TMPDIR /tmp --',
].join(" ")

function keys(value: Record<string, unknown>, allowed: string[]) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      throw new Error(`Read-only profile rejects config field: ${key}`)
    }
  }
}

export function validateReadOnly(header: unknown) {
  const h = record(header)
  keys(h, ["interlocutor", "interlocutors", "sandbox", "imports", "id"])
  if (h["sandbox"] !== readOnlySandbox) {
    throw new Error("Use the exact sandbox from the live example profile")
  }
  const others = h["interlocutors"]
  if (others !== undefined && (!Array.isArray(others) || others.length)) {
    throw new Error("Read-only live supports one interlocutor only")
  }
  const i = record(h["interlocutor"])
  keys(i, [
    "name", "prompt", "model", "provider", "account", "temperature",
    "max_tokens", "max_tool_use", "nocache", "thinking_budget",
    "thinking_effort", "verbosity", "service_tier", "tools",
  ])
  for (const field of ["prompt", "account"]) {
    if (typeof i[field] === "string" && i[field].trimStart()
      .startsWith("exec:")) throw new Error("Executable sources forbidden")
  }
  // Codex can supply its own tools outside Lectic's sandbox wrapper.
  if (i["provider"] === "codex" || !i["provider"]) {
    throw new Error("Set an explicit non-Codex provider")
  }
  const tools = i["tools"] ?? []
  if (!Array.isArray(tools)) throw new Error("Invalid tools")
  for (const tool of tools) {
    const t = record(tool)
    keys(t, [
      "exec", "name", "usage", "schema", "timeoutSeconds", "limit", "icon",
    ])
    if (typeof t["usage"] === "string" && t["usage"].trimStart()
      .startsWith("exec:")) throw new Error("Executable tool usage forbidden")
    if (typeof t["exec"] !== "string" || t["exec"].includes("\n")) {
      throw new Error("Only sandboxed exec tools are supported")
    }
  }
}

export async function checkReadOnly(options: RunOptions) {
  const parsed = await runChild({
    command: options.command ?? resolveLectic(),
    args: ["parse", "--effective-header", "-f",
      resolve(options.cwd, options.seed)],
    cwd: options.cwd, input: "", env: options.env,
    signal: options.signal, timeoutMs: 10_000,
  })
  validateReadOnly(record(JSON.parse(parsed))["header"])
}

// Pathname UNIX sockets bypass network namespaces even on read-only mounts.
// Do not expose existing repository sockets to arbitrary shell tools.
export async function checkWorkspace(cwd: string) {
  const pending = [cwd]
  let count = 0
  const deadline = Date.now() + 10_000
  while (pending.length) {
    const dir = pending.pop()!
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (++count > 200_000 || Date.now() > deadline) {
        throw new Error("Workspace too large to audit for IPC sockets")
      }
      if (entry.isSocket()) {
        throw new Error("Workspace contains an IPC socket; live refuses it")
      }
      if (entry.isDirectory()) pending.push(join(dir, entry.name))
    }
  }
}

export async function probeSandbox(cwd: string) {
  if (process.platform !== "linux" || !Bun.which("bwrap")) {
    throw new Error("Read-only live requires Linux and Bubblewrap (bwrap)")
  }
  const workspace = await realpath(cwd)
  if (workspace === "/" || workspace === process.env["HOME"]) {
    throw new Error("Launch from a repository, not / or your home directory")
  }
  await checkWorkspace(workspace)
  await runChild({
    command: ["bwrap"], cwd, input: "", timeoutMs: 5000,
    args: [
      "--unshare-all", "--die-with-parent", "--new-session",
      "--ro-bind", "/usr", "/usr", "--ro-bind-try", "/bin", "/bin",
      "--ro-bind-try", "/lib", "/lib", "--ro-bind-try", "/lib64", "/lib64",
      "--ro-bind-try", "/nix/store", "/nix/store",
      "--proc", "/proc", "--dev", "/dev",
      "--tmpfs", "/tmp", "--tmpfs", "/run",
      "--ro-bind", workspace, workspace, "--clearenv", "--",
      join(await realpath(dirname(Bun.which("true") ?? "/bin/true")),
        "true"),
    ],
  })
  return workspace
}
