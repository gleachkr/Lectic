export type TurnTaskState = "submitted" | "working" | "completed" | "failed"

export type TurnTaskSnapshot = {
  taskId: string
  contextId: string

  state: TurnTaskState

  createdAt: string
  updatedAt: string
  startedAt?: string
  endedAt?: string

  userText: string
  userMessageId: string

  messageChunks: string[]
  agentMessageIds: string[]
  finalMessage: string

  error?: string
}

export type RunTurn = (opt: {
  contextId: string
  userText: string
  onChunk: (chunk: string) => void
}) => Promise<void>

export type TurnTaskEventKind = "created" | "updated"

export type TurnTaskEvent = {
  kind: TurnTaskEventKind
  snapshot: TurnTaskSnapshot

  // For kind=updated
  prevState?: TurnTaskState
  stateChanged: boolean
}

type Waiter = {
  predicate: (snap: TurnTaskSnapshot) => boolean
  resolve: (snap: TurnTaskSnapshot) => void
}

type TurnTaskRecord = TurnTaskSnapshot & {
  waiters: Waiter[]
}

function nowIso(): string {
  return new Date().toISOString()
}

function isTerminal(state: TurnTaskState): boolean {
  return state === "completed" || state === "failed"
}

function cloneSnapshot(rec: TurnTaskRecord): TurnTaskSnapshot {
  const { waiters: _w, ...snap } = rec

  return {
    ...snap,
    messageChunks: [...snap.messageChunks],
    agentMessageIds: [...snap.agentMessageIds],
  }
}

export class TurnTaskHandle {
  readonly taskId: string
  readonly contextId: string
  readonly startedImmediately: boolean

  private readonly store: TurnTaskStore

  constructor(opt: {
    store: TurnTaskStore
    taskId: string
    contextId: string
    startedImmediately: boolean
  }) {
    this.store = opt.store
    this.taskId = opt.taskId
    this.contextId = opt.contextId
    this.startedImmediately = opt.startedImmediately
  }

  snapshot(): TurnTaskSnapshot {
    const snap = this.store.getSnapshot(this.taskId)
    if (!snap) {
      throw new Error(`Unknown taskId: ${this.taskId}`)
    }
    return snap
  }

  async waitForStarted(): Promise<TurnTaskSnapshot> {
    return this.store.waitFor(this.taskId, (snap) => {
      return snap.startedAt !== undefined || snap.state !== "submitted"
    })
  }

  async waitForTerminal(): Promise<TurnTaskSnapshot> {
    return this.store.waitFor(this.taskId, (snap) => isTerminal(snap.state))
  }
}

export class TurnTaskStore {
  private readonly runTurn: RunTurn
  private readonly maxTasksPerContext: number

  private readonly tasksById = new Map<string, TurnTaskRecord>()
  private readonly contextQueues = new Map<string, string[]>()
  private readonly contextOrder = new Map<string, string[]>()
  private readonly contextWorkers = new Set<string>()

  private readonly listeners = new Set<(ev: TurnTaskEvent) => void>()

  constructor(opt: { runTurn: RunTurn; maxTasksPerContext: number }) {
    this.runTurn = opt.runTurn
    this.maxTasksPerContext = opt.maxTasksPerContext
  }

  onEvent(listener: (ev: TurnTaskEvent) => void): () => void {
    this.listeners.add(listener)

    return () => {
      this.listeners.delete(listener)
    }
  }

  private emit(ev: TurnTaskEvent): void {
    for (const fn of this.listeners) {
      try {
        fn(ev)
      } catch {
        // Ignore monitoring errors.
      }
    }
  }

  listContextIds(): string[] {
    return [...this.contextOrder.keys()]
  }

  listTaskIds(contextId: string): string[] {
    return [...(this.contextOrder.get(contextId) ?? [])]
  }

  listTaskSnapshots(opt?: { contextId?: string }): TurnTaskSnapshot[] {
    const contextId = opt?.contextId

    if (contextId) {
      return this.listTaskIds(contextId)
        .map((taskId) => this.getSnapshot(taskId))
        .filter((s): s is TurnTaskSnapshot => s !== undefined)
    }

    const out: TurnTaskSnapshot[] = []

    for (const cid of this.listContextIds()) {
      out.push(...this.listTaskSnapshots({ contextId: cid }))
    }

    return out
  }

  hasTask(taskId: string): boolean {
    return this.tasksById.has(taskId)
  }

  getSnapshot(taskId: string): TurnTaskSnapshot | undefined {
    const rec = this.tasksById.get(taskId)
    if (!rec) return undefined
    return cloneSnapshot(rec)
  }

  enqueueTurn(opt: { contextId: string; userText: string }): TurnTaskHandle {
    const taskId = Bun.randomUUIDv7()

    const createdAt = nowIso()

    const rec: TurnTaskRecord = {
      taskId,
      contextId: opt.contextId,
      state: "submitted",
      createdAt,
      updatedAt: createdAt,
      userText: opt.userText,
      userMessageId: Bun.randomUUIDv7(),
      messageChunks: [],
      agentMessageIds: [],
      finalMessage: "",
      waiters: [],
    }

    this.tasksById.set(taskId, rec)

    this.emit({
      kind: "created",
      snapshot: cloneSnapshot(rec),
      stateChanged: false,
    })

    const order = this.contextOrder.get(opt.contextId) ?? []
    order.push(taskId)
    this.contextOrder.set(opt.contextId, order)

    const queue = this.contextQueues.get(opt.contextId) ?? []
    const startedImmediately =
      queue.length === 0 && !this.contextWorkers.has(opt.contextId)

    queue.push(taskId)
    this.contextQueues.set(opt.contextId, queue)

    this.ensureWorker(opt.contextId)
    this.gcContext(opt.contextId)

    return new TurnTaskHandle({
      store: this,
      taskId,
      contextId: opt.contextId,
      startedImmediately,
    })
  }

  private ensureWorker(contextId: string): void {
    if (this.contextWorkers.has(contextId)) return

    const queue = this.contextQueues.get(contextId)
    if (!queue || queue.length === 0) return

    this.contextWorkers.add(contextId)

    // Defer execution so callers can observe the initial `submitted`
    // snapshot before we transition to `working`.
    queueMicrotask(() => {
      void this.contextWorkerLoop(contextId).finally(() => {
        this.contextWorkers.delete(contextId)

        const nextQueue = this.contextQueues.get(contextId)
        if (nextQueue && nextQueue.length > 0) {
          this.ensureWorker(contextId)
        }
      })
    })
  }

  private async contextWorkerLoop(contextId: string): Promise<void> {
    while (true) {
      const queue = this.contextQueues.get(contextId)
      const taskId = queue?.[0]
      if (!taskId) return

      const rec = this.tasksById.get(taskId)
      if (!rec) {
        queue.shift()
        continue
      }

      this.update(taskId, (r) => {
        if (r.state !== "submitted") return

        r.state = "working"
        r.startedAt = nowIso()
        r.updatedAt = r.startedAt
      })

      try {
        await this.runTurn({
          contextId,
          userText: rec.userText,
          onChunk: (chunk) => {
            this.update(taskId, (r) => {
              r.messageChunks.push(chunk)
              r.agentMessageIds.push(Bun.randomUUIDv7())
              r.finalMessage = chunk
              r.updatedAt = nowIso()
            })
          },
        })

        this.update(taskId, (r) => {
          r.state = "completed"
          r.endedAt = nowIso()
          r.updatedAt = r.endedAt
        })
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)

        this.update(taskId, (r) => {
          r.state = "failed"
          r.error = msg

          r.endedAt = nowIso()
          r.updatedAt = r.endedAt
        })
      } finally {
        const q = this.contextQueues.get(contextId)
        if (q && q[0] === taskId) q.shift()
        this.gcContext(contextId)
      }
    }
  }

  private update(taskId: string, fn: (rec: TurnTaskRecord) => void): void {
    const rec = this.tasksById.get(taskId)
    if (!rec) return

    const prevState = rec.state

    fn(rec)

    const snap = cloneSnapshot(rec)

    const remaining: typeof rec.waiters = []

    for (const w of rec.waiters) {
      if (w.predicate(snap)) w.resolve(snap)
      else remaining.push(w)
    }

    rec.waiters = remaining

    this.emit({
      kind: "updated",
      snapshot: snap,
      prevState,
      stateChanged: prevState !== snap.state,
    })
  }

  async waitFor(
    taskId: string,
    predicate: (snap: TurnTaskSnapshot) => boolean,
  ): Promise<TurnTaskSnapshot> {
    const rec = this.tasksById.get(taskId)
    if (!rec) {
      throw new Error(`Unknown taskId: ${taskId}`)
    }

    const initial = cloneSnapshot(rec)
    if (predicate(initial)) return initial

    return new Promise<TurnTaskSnapshot>((resolve) => {
      rec.waiters.push({ predicate, resolve })
    })
  }

  private gcContext(contextId: string): void {
    const max = this.maxTasksPerContext
    if (!Number.isFinite(max) || max <= 0) return

    const order = this.contextOrder.get(contextId)
    if (!order) return

    while (order.length > max) {
      const oldest = order[0]
      const rec = oldest ? this.tasksById.get(oldest) : undefined

      if (!rec) {
        order.shift()
        continue
      }

      if (!isTerminal(rec.state)) {
        // Best effort: we only prune terminal tasks.
        break
      }

      this.tasksById.delete(oldest)
      order.shift()
    }

    if (order.length === 0) {
      this.contextOrder.delete(contextId)
    }
  }
}
