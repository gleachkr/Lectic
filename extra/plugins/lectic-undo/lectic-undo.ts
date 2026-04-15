#!/usr/bin/env -S lectic script

import { createHash, randomBytes } from "node:crypto"
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, relative, resolve } from "node:path"

type RepoInfo = {
  root: string
  gitDir: string
}

type SnapshotState = {
  id: string
  createdAt: string
}

type SnapshotRecord = {
  id: string
  worktreeRef: string
  worktreeCommit: string
  indexRef: string | null
  indexCommit: string | null
  createdAt: string
  head: string | null
  branch: string | null
  interlocutor: string | null
  file: string | null
  reason: string | null
}

type ParsedArgs = {
  command: string
  rest: string[]
}

type GitResult = {
  exitCode: number
  stdout: string
  stderr: string
}

const SNAPSHOT_REF_ROOT = "refs/lectic/undo"
const TOOL_NAME = "Lectic undo"

function usage(): string {
  return [
    "Usage:",
    "  lectic undo",
    "  lectic undo capture",
    "  lectic undo note",
    "  lectic undo list",
    "  lectic undo show <id>",
    "  lectic undo diff <id> [--index]",
    "  lectic undo restore <id> [--worktree-only | --index-only]",
    "  lectic undo prune [--keep-last N | --all]",
    "",
    "Commands:",
    "  <none>       Print the latest worktree snapshot ref.",
    "  capture      Save the current repo state for later restore.",
    "  note         Print restore instructions when the repo changed.",
    "  list         List saved undo snapshots.",
    "  show         Show metadata for one snapshot.",
    "  diff         Diff a snapshot against the current repo state.",
    "  restore      Restore worktree and index from a snapshot.",
    "  prune        Delete old snapshots.",
  ].join("\n")
}

function parseArgs(argv: string[]): ParsedArgs {
  if (argv.length === 0) {
    return { command: "current", rest: [] }
  }

  const [command, ...rest] = argv
  if (command === "-h" || command === "--help" || command === "help") {
    return { command: "help", rest }
  }

  return { command, rest }
}

function fail(message: string): never {
  console.error(message)
  process.exit(1)
}

function git(
  repo: RepoInfo,
  args: string[],
  opt?: {
    env?: Record<string, string>
    allowFailure?: boolean
  },
): string {
  const result = gitFull(repo, args, opt)
  if (result.exitCode !== 0 && !opt?.allowFailure) {
    const detail = result.stderr.trim() || result.stdout.trim() || "git failed"
    fail(`git ${args.join(" ")}: ${detail}`)
  }
  return result.stdout
}

function gitFull(
  repo: RepoInfo,
  args: string[],
  opt?: {
    env?: Record<string, string>
    allowFailure?: boolean
  },
): GitResult {
  const proc = Bun.spawnSync({
    cmd: ["git", ...args],
    cwd: repo.root,
    env: {
      ...process.env,
      ...(opt?.env ?? {}),
    },
    stdout: "pipe",
    stderr: "pipe",
  })

  return {
    exitCode: proc.exitCode,
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
  }
}

function discoverRepo(): RepoInfo | null {
  const rootProc = Bun.spawnSync({
    cmd: ["git", "rev-parse", "--show-toplevel"],
    stdout: "pipe",
    stderr: "pipe",
  })

  if (rootProc.exitCode !== 0) {
    return null
  }

  const root = rootProc.stdout.toString().trim()
  const gitDirProc = Bun.spawnSync({
    cmd: ["git", "rev-parse", "--git-dir"],
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  })

  if (gitDirProc.exitCode !== 0) {
    return null
  }

  const gitDirRaw = gitDirProc.stdout.toString().trim()
  const gitDir = resolve(root, gitDirRaw)
  return { root, gitDir }
}

function nowIso(): string {
  return new Date().toISOString()
}

function snapshotId(): string {
  const ts = nowIso().replace(/[:.]/g, "-")
  const suffix = randomBytes(4).toString("hex")
  return `${ts}-${suffix}`
}

function commitTrailers(record: SnapshotRecord): string[] {
  return [
    `Lectic-Undo-Id: ${record.id}`,
    `Lectic-Captured-At: ${record.createdAt}`,
    `Lectic-Reason: ${record.reason ?? "unknown"}`,
    `Lectic-Interlocutor: ${record.interlocutor ?? "unknown"}`,
    `Lectic-File: ${record.file ?? ""}`,
    `Lectic-Head: ${record.head ?? ""}`,
    `Lectic-Branch: ${record.branch ?? ""}`,
    `Lectic-Index-Ref: ${record.indexRef ?? "unavailable"}`,
  ]
}

function buildCommitMessage(
  kind: "worktree" | "index",
  record: SnapshotRecord,
): string {
  return [
    `Lectic undo snapshot (${kind})`,
    "",
    ...commitTrailers(record),
  ].join("\n")
}

function shortHead(repo: RepoInfo): string | null {
  const result = gitFull(repo, ["rev-parse", "--verify", "HEAD"], {
    allowFailure: true,
  })
  if (result.exitCode !== 0) {
    return null
  }
  return result.stdout.trim()
}

function currentBranch(repo: RepoInfo): string | null {
  const result = gitFull(
    repo,
    ["symbolic-ref", "--quiet", "--short", "HEAD"],
    {
      allowFailure: true,
    },
  )
  if (result.exitCode !== 0) {
    return null
  }
  return result.stdout.trim()
}

function writeTreeFromTempIndex(repo: RepoInfo): string {
  const tempIndex = join(
    tmpdir(),
    `lectic-undo-index-${process.pid}-${Date.now()}-${Math.random()}`,
  )

  try {
    git(repo, ["read-tree", "--empty"], {
      env: { GIT_INDEX_FILE: tempIndex },
    })
    git(repo, ["add", "-A", "--", ":/"], {
      env: { GIT_INDEX_FILE: tempIndex },
    })
    return git(repo, ["write-tree"], {
      env: { GIT_INDEX_FILE: tempIndex },
    }).trim()
  } finally {
    rmSync(tempIndex, { force: true })
  }
}

function writeCurrentIndexTree(repo: RepoInfo): string | null {
  const result = gitFull(repo, ["write-tree"], { allowFailure: true })
  if (result.exitCode !== 0) {
    return null
  }
  return result.stdout.trim()
}

function commitTree(
  repo: RepoInfo,
  tree: string,
  message: string,
  parent: string | null,
): string {
  const args = ["commit-tree", tree]
  if (parent !== null) {
    args.push("-p", parent)
  }
  args.push("-m", message)
  return git(repo, args).trim()
}

function worktreeRefFor(id: string): string {
  return `${SNAPSHOT_REF_ROOT}/${id}/worktree`
}

function indexRefFor(id: string): string {
  return `${SNAPSHOT_REF_ROOT}/${id}/index`
}

function updateRef(repo: RepoInfo, ref: string, commit: string): void {
  git(repo, ["update-ref", ref, commit])
}

function deleteRef(repo: RepoInfo, ref: string): void {
  gitFull(repo, ["update-ref", "-d", ref], { allowFailure: true })
}

function contextKey(repo: RepoInfo): string {
  const ctx = [
    repo.root,
    process.env["LECTIC_FILE"] ?? "",
    process.env["LECTIC_INTERLOCUTOR"] ?? "",
  ].join("\0")

  return createHash("sha1").update(ctx).digest("hex")
}

function pendingDir(repo: RepoInfo): string {
  return join(repo.gitDir, "lectic-undo", "pending")
}

function pendingStatePath(repo: RepoInfo): string {
  return join(pendingDir(repo), `${contextKey(repo)}.json`)
}

function writePendingState(repo: RepoInfo, state: SnapshotState): void {
  const dir = pendingDir(repo)
  mkdirSync(dir, { recursive: true })
  writeFileSync(pendingStatePath(repo), JSON.stringify(state, null, 2) + "\n")
}

function readPendingState(repo: RepoInfo): SnapshotState | null {
  const path = pendingStatePath(repo)
  if (!existsSync(path)) {
    return null
  }

  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as SnapshotState
    if (typeof parsed.id !== "string" || typeof parsed.createdAt !== "string") {
      return null
    }
    return parsed
  } catch {
    return null
  }
}

function clearPendingState(repo: RepoInfo): void {
  rmSync(pendingStatePath(repo), { force: true })
}

function captureSnapshot(repo: RepoInfo, reason: string): SnapshotRecord {
  const id = snapshotId()
  const createdAt = nowIso()
  const head = shortHead(repo)
  const branch = currentBranch(repo)
  const interlocutor = process.env["LECTIC_INTERLOCUTOR"] ?? null
  const file = process.env["LECTIC_FILE"] ?? null
  const worktreeTree = writeTreeFromTempIndex(repo)
  const indexTree = writeCurrentIndexTree(repo)
  const baseRecord: SnapshotRecord = {
    id,
    worktreeRef: worktreeRefFor(id),
    worktreeCommit: "",
    indexRef: indexTree === null ? null : indexRefFor(id),
    indexCommit: null,
    createdAt,
    head,
    branch,
    interlocutor,
    file,
    reason,
  }

  if (indexTree !== null && baseRecord.indexRef !== null) {
    const indexCommit = commitTree(
      repo,
      indexTree,
      buildCommitMessage("index", baseRecord),
      head,
    )
    updateRef(repo, baseRecord.indexRef, indexCommit)
    baseRecord.indexCommit = indexCommit
  }

  const worktreeCommit = commitTree(
    repo,
    worktreeTree,
    buildCommitMessage("worktree", baseRecord),
    head,
  )
  updateRef(repo, baseRecord.worktreeRef, worktreeCommit)
  baseRecord.worktreeCommit = worktreeCommit

  return baseRecord
}

function parseTrailers(text: string): Record<string, string> {
  const trailers: Record<string, string> = {}
  for (const line of text.split("\n")) {
    const idx = line.indexOf(":")
    if (idx <= 0) {
      continue
    }
    const key = line.slice(0, idx).trim()
    if (!key.startsWith("Lectic-")) {
      continue
    }
    trailers[key] = line.slice(idx + 1).trim()
  }
  return trailers
}

function loadSnapshot(repo: RepoInfo, id: string): SnapshotRecord {
  const worktreeRef = worktreeRefFor(id)
  const verify = gitFull(repo, ["rev-parse", "--verify", worktreeRef], {
    allowFailure: true,
  })
  if (verify.exitCode !== 0) {
    fail(`No undo snapshot found for '${id}'.`)
  }

  const worktreeCommit = verify.stdout.trim()
  const indexVerify = gitFull(
    repo,
    ["rev-parse", "--verify", indexRefFor(id)],
    {
      allowFailure: true,
    },
  )
  const indexCommit = indexVerify.exitCode === 0 ? indexVerify.stdout.trim() : null
  const message = git(repo, ["show", "-s", "--format=%B", worktreeCommit])
  const trailers = parseTrailers(message)
  const indexRefTrailer = trailers["Lectic-Index-Ref"]
  const indexRef = indexCommit === null || indexRefTrailer === "unavailable"
    ? null
    : indexRefFor(id)

  return {
    id,
    worktreeRef,
    worktreeCommit,
    indexRef,
    indexCommit,
    createdAt: trailers["Lectic-Captured-At"] ?? "",
    head: trailers["Lectic-Head"] || null,
    branch: trailers["Lectic-Branch"] || null,
    interlocutor: trailers["Lectic-Interlocutor"] || null,
    file: trailers["Lectic-File"] || null,
    reason: trailers["Lectic-Reason"] || null,
  }
}

function commitTreeId(repo: RepoInfo, ref: string): string {
  return git(repo, ["show", "-s", "--format=%T", ref]).trim()
}

function snapshotChanged(repo: RepoInfo, snapshot: SnapshotRecord): boolean {
  const currentWorktreeTree = writeTreeFromTempIndex(repo)
  const savedWorktreeTree = commitTreeId(repo, snapshot.worktreeRef)
  if (currentWorktreeTree !== savedWorktreeTree) {
    return true
  }

  if (snapshot.indexRef === null) {
    return false
  }

  const currentIndexTree = writeCurrentIndexTree(repo)
  if (currentIndexTree === null) {
    return true
  }

  const savedIndexTree = commitTreeId(repo, snapshot.indexRef)
  return currentIndexTree !== savedIndexTree
}

function deleteSnapshot(repo: RepoInfo, snapshot: SnapshotRecord): void {
  deleteRef(repo, snapshot.worktreeRef)
  if (snapshot.indexRef !== null) {
    deleteRef(repo, snapshot.indexRef)
  }
}

function commandCapture(repo: RepoInfo): void {
  const previous = readPendingState(repo)
  if (previous !== null) {
    const verify = gitFull(repo, [
      "rev-parse",
      "--verify",
      worktreeRefFor(previous.id),
    ], {
      allowFailure: true,
    })
    if (verify.exitCode === 0) {
      deleteSnapshot(repo, loadSnapshot(repo, previous.id))
    }
    clearPendingState(repo)
  }

  const snapshot = captureSnapshot(repo, "user_message")
  writePendingState(repo, {
    id: snapshot.id,
    createdAt: snapshot.createdAt,
  })
}

function commandNote(repo: RepoInfo): void {
  const pending = readPendingState(repo)
  if (pending === null) {
    return
  }

  const verify = gitFull(repo, [
    "rev-parse",
    "--verify",
    worktreeRefFor(pending.id),
  ], {
    allowFailure: true,
  })
  if (verify.exitCode !== 0) {
    clearPendingState(repo)
    return
  }

  const snapshot = loadSnapshot(repo, pending.id)
  const changed = snapshotChanged(repo, snapshot)
  clearPendingState(repo)

  if (!changed) {
    deleteSnapshot(repo, snapshot)
    return
  }

  console.log(`Lectic undo snapshot: ${snapshot.id}`)
  console.log(`Restore: lectic undo restore ${snapshot.id}`)
  console.log(`Show: lectic undo show ${snapshot.id}`)
}

function listSnapshotIds(repo: RepoInfo): string[] {
  const output = gitFull(
    repo,
    [
      "for-each-ref",
      "--sort=-creatordate",
      "--format=%(refname)",
      SNAPSHOT_REF_ROOT,
    ],
    { allowFailure: true },
  )

  if (output.exitCode !== 0) {
    return []
  }

  return output.stdout
    .split("\n")
    .map(line => line.trim())
    .filter(ref => ref.startsWith(`${SNAPSHOT_REF_ROOT}/`))
    .filter(ref => ref.endsWith("/worktree"))
    .map((ref) => ref.replace(`${SNAPSHOT_REF_ROOT}/`, ""))
    .map((rest) => rest.replace(/\/worktree$/, ""))
}

function latestSnapshot(repo: RepoInfo): SnapshotRecord {
  const ids = listSnapshotIds(repo)
  if (ids.length === 0) {
    fail("No undo snapshots saved.")
  }

  return loadSnapshot(repo, ids[0])
}

function commandCurrent(repo: RepoInfo): void {
  console.log(latestSnapshot(repo).worktreeRef)
}

function commandList(repo: RepoInfo): void {
  const ids = listSnapshotIds(repo)
  if (ids.length === 0) {
    console.log("No undo snapshots saved.")
    return
  }

  for (const id of ids) {
    const snapshot = loadSnapshot(repo, id)
    const head = snapshot.head === null ? "-" : snapshot.head.slice(0, 12)
    const branch = snapshot.branch ?? "-"
    const index = snapshot.indexRef === null ? "no-index" : "with-index"
    console.log(
      [id, snapshot.createdAt || "-", branch, head, index].join("\t"),
    )
  }
}

function commandShow(repo: RepoInfo, id: string | undefined): void {
  if (!id) {
    fail("Usage: lectic undo show <id>")
  }

  const snapshot = loadSnapshot(repo, id)
  const lines = [
    `id: ${snapshot.id}`,
    `captured_at: ${snapshot.createdAt || ""}`,
    `reason: ${snapshot.reason || ""}`,
    `branch: ${snapshot.branch || ""}`,
    `head: ${snapshot.head || ""}`,
    `interlocutor: ${snapshot.interlocutor || ""}`,
    `file: ${snapshot.file || ""}`,
    `worktree_ref: ${snapshot.worktreeRef}`,
    `worktree_commit: ${snapshot.worktreeCommit}`,
    `index_ref: ${snapshot.indexRef || ""}`,
    `index_commit: ${snapshot.indexCommit || ""}`,
    `diff: lectic undo diff ${snapshot.id}`,
    `restore: lectic undo restore ${snapshot.id}`,
  ]

  console.log(lines.join("\n"))
}

function listPathsFromTree(repo: RepoInfo, ref: string): Set<string> {
  const output = git(repo, ["ls-tree", "-r", "-z", "--name-only", ref])
  return new Set(output.split("\0").filter(Boolean))
}

function listCurrentPaths(repo: RepoInfo): Set<string> {
  const output = git(
    repo,
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
  )
  return new Set(output.split("\0").filter(Boolean))
}

function isInsideRoot(root: string, path: string): boolean {
  const rel = relative(root, path)
  return rel !== "" && !rel.startsWith("..")
}

function removeEmptyParents(path: string, root: string): void {
  let current = dirname(path)
  while (isInsideRoot(root, current)) {
    try {
      if (!statSync(current).isDirectory()) {
        return
      }
      if (readdirSync(current).length !== 0) {
        return
      }
      rmSync(current, { recursive: false, force: true })
    } catch {
      return
    }

    current = dirname(current)
  }
}

function deletePathIfPresent(repo: RepoInfo, relPath: string): void {
  const absPath = resolve(repo.root, relPath)
  if (!isInsideRoot(repo.root, absPath)) {
    fail(`Refusing to delete path outside repo: ${relPath}`)
  }

  rmSync(absPath, { recursive: true, force: true })
  removeEmptyParents(absPath, repo.root)
}

function checkoutTreeToWorktree(repo: RepoInfo, ref: string): void {
  const tempIndex = join(
    tmpdir(),
    `lectic-undo-restore-${process.pid}-${Date.now()}-${Math.random()}`,
  )

  try {
    git(repo, ["read-tree", `${ref}^{tree}`], {
      env: { GIT_INDEX_FILE: tempIndex },
    })
    git(repo, ["checkout-index", "--all", "--force"], {
      env: { GIT_INDEX_FILE: tempIndex },
    })
  } finally {
    rmSync(tempIndex, { force: true })
  }
}

function restoreIndex(repo: RepoInfo, ref: string): void {
  const tree = commitTreeId(repo, ref)
  git(repo, ["read-tree", "--reset", tree])
}

function diffTrees(repo: RepoInfo, left: string, right: string): void {
  const proc = Bun.spawnSync({
    cmd: ["git", "diff", "--find-renames", left, right],
    cwd: repo.root,
    stdout: "inherit",
    stderr: "inherit",
  })

  if (proc.exitCode !== 0) {
    fail("git diff failed")
  }
}

function commandDiff(repo: RepoInfo, argv: string[]): void {
  let id: string | null = null
  let diffIndex = false

  for (const arg of argv) {
    if (arg === "--index") {
      diffIndex = true
      continue
    }
    if (id === null) {
      id = arg
      continue
    }
    fail(`Unknown diff argument: ${arg}`)
  }

  if (id === null) {
    fail("Usage: lectic undo diff <id> [--index]")
  }

  const snapshot = loadSnapshot(repo, id)

  if (diffIndex) {
    if (snapshot.indexRef === null) {
      fail(`Snapshot '${snapshot.id}' does not include an index snapshot.`)
    }
    const currentIndexTree = writeCurrentIndexTree(repo)
    if (currentIndexTree === null) {
      fail("The current index could not be written as a tree.")
    }
    diffTrees(
      repo,
      commitTreeId(repo, snapshot.indexRef),
      currentIndexTree,
    )
    return
  }

  diffTrees(
    repo,
    commitTreeId(repo, snapshot.worktreeRef),
    writeTreeFromTempIndex(repo),
  )
}

function commandRestore(repo: RepoInfo, argv: string[]): void {
  let id: string | null = null
  let restoreWorktree = true
  let restoreIndexToo = true

  for (const arg of argv) {
    if (arg === "--worktree-only") {
      restoreIndexToo = false
      continue
    }
    if (arg === "--index-only") {
      restoreWorktree = false
      restoreIndexToo = true
      continue
    }
    if (id === null) {
      id = arg
      continue
    }
    fail(`Unknown restore argument: ${arg}`)
  }

  if (id === null) {
    fail("Usage: lectic undo restore <id> [--worktree-only | --index-only]")
  }

  const snapshot = loadSnapshot(repo, id)

  if (restoreWorktree) {
    const currentPaths = listCurrentPaths(repo)
    const snapshotPaths = listPathsFromTree(repo, snapshot.worktreeRef)
    for (const relPath of currentPaths) {
      if (!snapshotPaths.has(relPath)) {
        deletePathIfPresent(repo, relPath)
      }
    }
    checkoutTreeToWorktree(repo, snapshot.worktreeRef)
  }

  if (restoreIndexToo) {
    if (snapshot.indexRef === null) {
      fail(`Snapshot '${snapshot.id}' does not include an index snapshot.`)
    }
    restoreIndex(repo, snapshot.indexRef)
  }

  console.log(`Restored snapshot ${snapshot.id}.`)
}

function commandPrune(repo: RepoInfo, argv: string[]): void {
  let keepLast = 20
  let pruneAll = false

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === "--all") {
      pruneAll = true
      continue
    }
    if (arg === "--keep-last") {
      const value = argv[i + 1]
      if (!value) {
        fail("--keep-last requires a number")
      }
      keepLast = Number.parseInt(value, 10)
      if (!Number.isFinite(keepLast) || keepLast < 0) {
        fail("--keep-last requires a non-negative integer")
      }
      i += 1
      continue
    }
    fail(`Unknown prune argument: ${arg}`)
  }

  const ids = listSnapshotIds(repo)
  const doomed = pruneAll ? ids : ids.slice(keepLast)

  for (const id of doomed) {
    deleteSnapshot(repo, loadSnapshot(repo, id))
    console.log(`Deleted ${id}`)
  }
}

function main(argv: string[]): void {
  const parsed = parseArgs(argv)
  if (parsed.command === "help") {
    console.log(usage())
    return
  }

  const repo = discoverRepo()
  if (repo === null) {
    if (parsed.command === "capture" || parsed.command === "note") {
      return
    }
    fail(`${TOOL_NAME} only works inside a git repository.`)
  }

  switch (parsed.command) {
    case "current":
      commandCurrent(repo)
      return
    case "capture":
      commandCapture(repo)
      return
    case "note":
      commandNote(repo)
      return
    case "list":
      commandList(repo)
      return
    case "show":
      commandShow(repo, parsed.rest[0])
      return
    case "diff":
      commandDiff(repo, parsed.rest)
      return
    case "restore":
      commandRestore(repo, parsed.rest)
      return
    case "prune":
      commandPrune(repo, parsed.rest)
      return
    default:
      fail(`Unknown undo command '${parsed.command}'.`)
  }
}

main(process.argv.slice(2))
