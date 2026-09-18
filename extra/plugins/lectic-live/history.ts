import { randomUUID } from "node:crypto"
import {
  appendFileSync, mkdirSync, readFileSync, renameSync, statSync,
  writeFileSync,
} from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { record, text } from "./validation"
import type { Owner } from "./provider"
import type { Task } from "./state"

// Optional v1 metadata: omission means an OpenAI provider-owned ID.
type HistoryOwner = {
  provider?: Owner["provider"]
  sessionIdSource?: Owner["sessionIdSource"]
  sessionId: string
}

// This is context for a new conversation, never a queue to execute.
export type HistoryContext = {
  version: 1
  conversationId: string
  incomplete: boolean
  fragments: (HistoryOwner & {
    sequence: number; speaker: string; text: string
  })[]
  tasks: (Task & HistoryOwner)[]
}

export const historyLimit = 8192

export function boundHistory(context: HistoryContext): HistoryContext {
  const result = structuredClone(context)
  // Prefer findings to old speech. Keep a bounded working context even when
  // the opt-in archive retains the full session.
  while (Buffer.byteLength(JSON.stringify(result)) > historyLimit) {
    result.incomplete = true
    if (result.fragments.length) result.fragments.shift()
    else if (result.tasks.length) result.tasks.shift()
    else throw new Error("History metadata exceeds context limit")
  }
  return result
}

export function historyRoot(env: NodeJS.ProcessEnv = process.env) {
  const state = env["LECTIC_STATE"] || join(
    env["XDG_STATE_HOME"] || join(homedir(), ".local", "state"), "lectic",
  )
  return join(state, "live")
}

export function loadHistory(id: string, root = historyRoot()) {
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error("Invalid history ID")
  const path = join(root, id, "context.json")
  if (statSync(path).size > historyLimit) {
    throw new Error("Saved context exceeds limit")
  }
  const value = record(JSON.parse(readFileSync(path, "utf8")))
  if (value["version"] !== 1 || typeof value["incomplete"] !== "boolean"
    || !Array.isArray(value["fragments"]) || !Array.isArray(value["tasks"])) {
    throw new Error("Unsupported history format")
  }
  const conversationId = text(value["conversationId"])
  if (!/^[a-f0-9-]{36}$/.test(conversationId)) {
    throw new Error("Invalid conversation ID")
  }
  for (const fragment of value["fragments"]) {
    const f = record(fragment)
    text(f["sessionId"])
    text(f["speaker"])
    text(f["text"])
    if (!Number.isSafeInteger(f["sequence"]) || Number(f["sequence"]) < 0) {
      throw new Error("Invalid saved fragment sequence")
    }
  }
  for (const task of value["tasks"]) {
    const t = record(task)
    text(t["sessionId"])
    text(t["delegationId"])
  }
  // Saved fields are read as inert model context only. They never supply
  // commands, paths, executable task state, or Live session ownership.
  return value as HistoryContext
}

export class History {
  readonly id = randomUUID()
  readonly dir: string
  private lastContext = ""
  private failed = false

  constructor(
    metadata: {
      seed: string; cwd: string; resumedFrom?: string
      provider?: Owner["provider"]; model?: string
    },
    root = historyRoot(),
  ) {
    this.dir = join(root, this.id)
    mkdirSync(this.dir, { recursive: true, mode: 0o700 })
    writeFileSync(join(this.dir, "session.json"), JSON.stringify({
      version: 1, created: new Date().toISOString(), ...metadata,
    }, null, 2) + "\n", { mode: 0o600 })
  }

  private write(action: () => void) {
    if (this.failed) return
    try { action() } catch (error) {
      this.failed = true
      console.error(`lectic live: history saving failed in ${this.dir}:`,
        error)
    }
  }

  append(kind: string, value: unknown) {
    this.write(() => appendFileSync(join(this.dir, "events.jsonl"),
      JSON.stringify({ at: Date.now(), kind, value }) + "\n",
      { mode: 0o600 }))
  }

  checkpoint(context: HistoryContext, reset = false) {
    // Model-window eviction must not erase the saved resume checkpoint.
    // Only explicit Clear resets it; disk context has its own size bound.
    const old = this.lastContext && !reset
      ? JSON.parse(this.lastContext) as HistoryContext : undefined
    const json = JSON.stringify(mergeHistory(old, context))
    if (json === this.lastContext) return
    this.write(() => {
      const temporary = join(this.dir, "context.json.tmp")
      writeFileSync(temporary, json, { mode: 0o600 })
      renameSync(temporary, join(this.dir, "context.json"))
      appendFileSync(join(this.dir, "events.jsonl"), JSON.stringify({
        at: Date.now(), kind: "context", value: JSON.parse(json),
      }) + "\n", { mode: 0o600 })
      this.lastContext = json
    })
  }
}

// Preserve fields removed from the working window, updating observed states.
function merge<T>(old: T[], current: T[], key: (item: T) => string): T[] {
  const items = new Map(old.map(item => [key(item), item]))
  for (const item of current) {
    const id = key(item)
    const value = { ...items.get(id), ...item }
    items.delete(id)
    items.set(id, value)
  }
  return [...items.values()]
}

// Shared by disk checkpoints, CLI resume, and in-memory idle reconnects.
export function mergeHistory(
  old: HistoryContext | undefined, context: HistoryContext,
): HistoryContext {
  if (!old) return boundHistory(context)
  return boundHistory({ ...context,
    incomplete: context.incomplete || old.incomplete,
    fragments: merge(old.fragments, context.fragments,
      f => JSON.stringify([...ownerKey(f), f.sequence])),
    tasks: merge(old.tasks, context.tasks,
      t => JSON.stringify([...ownerKey(t), t.delegationId])),
  })
}

function ownerKey(value: HistoryOwner) {
  return [value.provider ?? "openai", value.sessionIdSource ?? "provider",
    value.sessionId]
}
