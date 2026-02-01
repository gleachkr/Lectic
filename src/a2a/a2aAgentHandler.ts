import type {
  AgentCard,
  Message,
  MessageSendParams,
  Part,
  TextPart,
  Task,
  TaskArtifactUpdateEvent,
  TaskStatusUpdateEvent,
  TaskIdParams,
  TaskPushNotificationConfig,
  TaskQueryParams,
  GetTaskPushNotificationConfigParams,
  ListTaskPushNotificationConfigParams,
  DeleteTaskPushNotificationConfigParams,
} from "@a2a-js/sdk"

import { A2AError, type A2ARequestHandler } from "@a2a-js/sdk/server"
import type { ServerCallContext } from "@a2a-js/sdk/server"

import { resolveA2AContextId } from "./contextId"
import type { PersistedAgentRuntime } from "../agents/persistedRuntime"

import { normalizeAgentText } from "../agents/agentText"
import {
  TurnTaskStore,
  type TurnTaskEvent,
  type TurnTaskSnapshot,
  type TurnTaskState,
} from "../agents/turnTasks"

// message/send may return either a Message (fast completion) or a Task.
//
// We keep the default fast-path window small so that slow model providers
// don't cause the entire request to block (and potentially time out).
const DEFAULT_FAST_PATH_MS = 5000
const DEFAULT_MAX_TASKS_PER_CONTEXT = 50

function extractTextFromParts(parts: Part[]): string {
  return parts
    .filter((p): p is TextPart => p.kind === "text")
    .map((p) => p.text)
    .join("")
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function isTerminalState(state: TurnTaskState): boolean {
  return state === "completed" || state === "failed"
}

export class A2AAgentHandler implements A2ARequestHandler {
  private readonly card: AgentCard
  private readonly tasks: TurnTaskStore
  private readonly fastPathMs: number

  constructor(opt: {
    runtime: PersistedAgentRuntime
    card: AgentCard
    maxTasksPerContext?: number
    fastPathMs?: number
  }) {
    this.card = opt.card

    this.tasks = new TurnTaskStore({
      maxTasksPerContext:
        opt.maxTasksPerContext ?? DEFAULT_MAX_TASKS_PER_CONTEXT,
      runTurn: async (args) => {
        await opt.runtime.runTurn({
          contextId: args.contextId,
          userText: args.userText,
          onAssistantPassText: (text) => {
            const norm = normalizeAgentText(text)
            if (norm.trim().length === 0) return

            args.onChunk(norm)
          },
        })
      },
    })

    this.fastPathMs = opt.fastPathMs ?? DEFAULT_FAST_PATH_MS
  }

  async getAgentCard(): Promise<AgentCard> {
    return this.card
  }

  async getAuthenticatedExtendedAgentCard(
    _context?: ServerCallContext
  ): Promise<AgentCard> {
    throw A2AError.unsupportedOperation("agent/getAuthenticatedExtendedCard")
  }

  // Monitoring / debugging support

  listContextIds(): string[] {
    return this.tasks.listContextIds()
  }

  listTaskIds(contextId: string): string[] {
    return this.tasks.listTaskIds(contextId)
  }

  listTaskSnapshots(opt?: { contextId?: string }): TurnTaskSnapshot[] {
    return this.tasks.listTaskSnapshots(opt)
  }

  getTaskSnapshot(taskId: string): TurnTaskSnapshot | undefined {
    return this.tasks.getSnapshot(taskId)
  }

  onTaskEvent(listener: (ev: TurnTaskEvent) => void): () => void {
    return this.tasks.onEvent(listener)
  }

  private resolveContextId(input?: string | null): string {
    try {
      return resolveA2AContextId(input)
    } catch (e) {
      throw A2AError.invalidParams(
        e instanceof Error ? e.message : "Invalid contextId"
      )
    }
  }

  private parseIncomingSend(params: MessageSendParams): {
    contextId: string
    userText: string
  } {
    const incoming = params.message

    const contextId = this.resolveContextId(incoming.contextId)
    this.validateClientTaskId(incoming.taskId)

    return {
      contextId,
      userText: extractTextFromParts(incoming.parts),
    }
  }

  private validateClientTaskId(taskId?: string | null): void {
    if (taskId == null) return

    if (!this.tasks.hasTask(taskId)) {
      throw A2AError.invalidParams(
        `Unknown taskId ${JSON.stringify(taskId)}. Use tasks/get to poll ` +
          "an existing task, or omit taskId when sending a new message."
      )
    }

    throw A2AError.invalidParams(
      `Client-supplied taskId ${JSON.stringify(taskId)} is not supported for ` +
        "message/send. This server always creates a new task per turn. " +
        "Use tasks/get to poll existing tasks."
    )
  }

  private mkTextMessage(opt: {
    role: "user" | "agent"
    messageId: string
    contextId: string
    taskId: string
    text: string
  }): Message {
    return {
      kind: "message",
      role: opt.role,
      messageId: opt.messageId,
      contextId: opt.contextId,
      taskId: opt.taskId,
      parts: [{ kind: "text", text: opt.text }],
    }
  }

  private snapshotToUserMessage(snap: TurnTaskSnapshot): Message {
    return this.mkTextMessage({
      role: "user",
      messageId: snap.userMessageId,
      contextId: snap.contextId,
      taskId: snap.taskId,
      text: snap.userText,
    })
  }

  private snapshotToAgentMessages(snap: TurnTaskSnapshot): Message[] {
    const out: Message[] = []

    for (let i = 0; i < snap.messageChunks.length; i++) {
      const messageId = snap.agentMessageIds[i] ?? Bun.randomUUIDv7()

      out.push(
        this.mkTextMessage({
          role: "agent",
          messageId,
          contextId: snap.contextId,
          taskId: snap.taskId,
          text: snap.messageChunks[i],
        })
      )
    }

    return out
  }

  private snapshotToTerminalAgentMessage(snap: TurnTaskSnapshot): Message {
    if (snap.messageChunks.length > 0) {
      const idx = snap.messageChunks.length - 1
      const messageId = snap.agentMessageIds[idx] ?? Bun.randomUUIDv7()

      return this.mkTextMessage({
        role: "agent",
        messageId,
        contextId: snap.contextId,
        taskId: snap.taskId,
        text: snap.finalMessage,
      })
    }

    const fallbackText =
      snap.error && snap.error.length > 0 ? `Task failed: ${snap.error}` : ""

    return this.mkTextMessage({
      role: "agent",
      messageId: `${snap.taskId}-terminal`,
      contextId: snap.contextId,
      taskId: snap.taskId,
      text: fallbackText,
    })
  }

  private snapshotToTask(snap: TurnTaskSnapshot): Task {
    const userMessage = this.snapshotToUserMessage(snap)
    const agentMessages = this.snapshotToAgentMessages(snap)

    const task: Task = {
      kind: "task",
      id: snap.taskId,
      contextId: snap.contextId,
      status: {
        state: snap.state,
        timestamp: snap.updatedAt,
      },
      history: [userMessage, ...agentMessages],
    }

    if (isTerminalState(snap.state)) {
      task.status.message = this.snapshotToTerminalAgentMessage(snap)
    }

    return task
  }

  private statusUpdateEvent(opt: {
    taskId: string
    contextId: string
    state: TurnTaskState
    timestamp: string
    final: boolean
    message?: Message
  }): TaskStatusUpdateEvent {
    return {
      kind: "status-update",
      taskId: opt.taskId,
      contextId: opt.contextId,
      final: opt.final,
      status: {
        state: opt.state,
        timestamp: opt.timestamp,
        message: opt.message,
      },
    }
  }

  private async fastPathMessage(taskId: string): Promise<Message | null> {
    const deadline = this.fastPathMs
    if (deadline <= 0) return null

    const terminal = await Promise.race<TurnTaskSnapshot | null>([
      this.tasks.waitFor(taskId, (s) => isTerminalState(s.state)),
      delay(deadline).then(() => null),
    ])

    if (!terminal || terminal.state !== "completed") return null

    return this.snapshotToTerminalAgentMessage(terminal)
  }

  async sendMessage(
    params: MessageSendParams,
    _context?: ServerCallContext
  ): Promise<Message | Task> {
    const { contextId, userText } = this.parseIncomingSend(params)

    const handle = this.tasks.enqueueTurn({ contextId, userText })

    if (handle.startedImmediately) {
      const msg = await this.fastPathMessage(handle.taskId)
      if (msg) return msg
    }

    return this.snapshotToTask(handle.snapshot())
  }

  private unknownTaskId(taskId: string): never {
    throw A2AError.invalidParams(
      `Unknown taskId ${JSON.stringify(taskId)} (expired or never existed).`
    )
  }

  private createTaskEventWaiter(taskId: string): {
    nextEvent: () => Promise<TurnTaskEvent | null>
    unsubscribe: () => void
  } {
    const pending: TurnTaskEvent[] = []
    let notify: (() => void) | undefined
    let closed = false

    const unsub = this.tasks.onEvent((ev) => {
      if (ev.snapshot.taskId !== taskId) return

      pending.push(ev)
      notify?.()
    })

    const unsubscribe = () => {
      if (closed) return
      closed = true
      unsub()
      notify?.()
    }

    const nextEvent = async (): Promise<TurnTaskEvent | null> => {
      while (true) {
        const ev = pending.shift()
        if (ev) return ev
        if (closed) return null

        await new Promise<void>((resolve) => {
          notify = () => {
            notify = undefined
            resolve()
          }
        })
      }
    }

    return { nextEvent, unsubscribe }
  }

  private async *streamTask(opt: {
    taskId: string
    replayChunks: boolean
    emitWorkingFromInitial: boolean
  }): AsyncGenerator<Task | TaskStatusUpdateEvent, void, undefined> {
    const taskId = opt.taskId

    if (!this.tasks.hasTask(taskId)) {
      this.unknownTaskId(taskId)
    }

    const waiter = this.createTaskEventWaiter(taskId)

    try {
      const initial = this.tasks.getSnapshot(taskId)

      if (!initial) {
        this.unknownTaskId(taskId)
      }

      yield this.snapshotToTask(initial)

      let sentChunks = opt.replayChunks ? 0 : initial.messageChunks.length
      let workingEmitted = false

      if (
        opt.emitWorkingFromInitial &&
        initial.state === "working" &&
        initial.startedAt
      ) {
        yield this.statusUpdateEvent({
          taskId: initial.taskId,
          contextId: initial.contextId,
          state: "working",
          timestamp: initial.startedAt,
          final: false,
        })

        workingEmitted = true
      }

      if (opt.replayChunks) {
        for (let i = 0; i < initial.messageChunks.length; i++) {
          const messageId = initial.agentMessageIds[i] ?? Bun.randomUUIDv7()

          const msg = this.mkTextMessage({
            role: "agent",
            messageId,
            contextId: initial.contextId,
            taskId: initial.taskId,
            text: initial.messageChunks[i],
          })

          yield this.statusUpdateEvent({
            taskId: initial.taskId,
            contextId: initial.contextId,
            state: "working",
            timestamp: initial.updatedAt,
            final: false,
            message: msg,
          })
        }

        sentChunks = initial.messageChunks.length
      }

      if (isTerminalState(initial.state)) {
        yield this.statusUpdateEvent({
          taskId: initial.taskId,
          contextId: initial.contextId,
          state: initial.state,
          timestamp: initial.updatedAt,
          final: true,
          message: this.snapshotToTerminalAgentMessage(initial),
        })

        return
      }

      while (true) {
        const ev = await waiter.nextEvent()
        if (!ev) return
        if (ev.kind !== "updated") continue

        const snap = ev.snapshot

        if (
          !workingEmitted &&
          ev.stateChanged &&
          snap.state === "working" &&
          snap.startedAt
        ) {
          yield this.statusUpdateEvent({
            taskId: snap.taskId,
            contextId: snap.contextId,
            state: "working",
            timestamp: snap.startedAt,
            final: false,
          })

          workingEmitted = true
        }

        for (let i = sentChunks; i < snap.messageChunks.length; i++) {
          const messageId = snap.agentMessageIds[i] ?? Bun.randomUUIDv7()

          const msg = this.mkTextMessage({
            role: "agent",
            messageId,
            contextId: snap.contextId,
            taskId: snap.taskId,
            text: snap.messageChunks[i],
          })

          yield this.statusUpdateEvent({
            taskId: snap.taskId,
            contextId: snap.contextId,
            state: "working",
            timestamp: snap.updatedAt,
            final: false,
            message: msg,
          })
        }

        sentChunks = snap.messageChunks.length

        if (isTerminalState(snap.state)) {
          yield this.statusUpdateEvent({
            taskId: snap.taskId,
            contextId: snap.contextId,
            state: snap.state,
            timestamp: snap.updatedAt,
            final: true,
            message: this.snapshotToTerminalAgentMessage(snap),
          })

          return
        }
      }
    } finally {
      waiter.unsubscribe()
    }
  }

  async *sendMessageStream(
    params: MessageSendParams,
    _context?: ServerCallContext
  ): AsyncGenerator<
    Message | Task | TaskStatusUpdateEvent | TaskArtifactUpdateEvent,
    void,
    undefined
  > {
    const { contextId, userText } = this.parseIncomingSend(params)

    const handle = this.tasks.enqueueTurn({ contextId, userText })

    yield* this.streamTask({
      taskId: handle.taskId,
      replayChunks: true,
      emitWorkingFromInitial: true,
    })
  }

  async getTask(
    params: TaskQueryParams,
    _context?: ServerCallContext
  ): Promise<Task> {
    const taskId = params.id

    const snap = this.tasks.getSnapshot(taskId)

    if (!snap) {
      throw A2AError.invalidParams(
        `Unknown taskId ${JSON.stringify(taskId)} (expired or never existed).`
      )
    }

    return this.snapshotToTask(snap)
  }

  async cancelTask(
    _params: TaskIdParams,
    _context?: ServerCallContext
  ): Promise<Task> {
    throw A2AError.unsupportedOperation("tasks/cancel")
  }

  async setTaskPushNotificationConfig(
    _params: TaskPushNotificationConfig,
    _context?: ServerCallContext
  ): Promise<TaskPushNotificationConfig> {
    throw A2AError.unsupportedOperation("tasks/pushNotificationConfig/set")
  }

  async getTaskPushNotificationConfig(
    _params: TaskIdParams | GetTaskPushNotificationConfigParams,
    _context?: ServerCallContext
  ): Promise<TaskPushNotificationConfig> {
    throw A2AError.unsupportedOperation("tasks/pushNotificationConfig/get")
  }

  async listTaskPushNotificationConfigs(
    _params: ListTaskPushNotificationConfigParams,
    _context?: ServerCallContext
  ): Promise<TaskPushNotificationConfig[]> {
    throw A2AError.unsupportedOperation("tasks/pushNotificationConfig/list")
  }

  async deleteTaskPushNotificationConfig(
    _params: DeleteTaskPushNotificationConfigParams,
    _context?: ServerCallContext
  ): Promise<void> {
    throw A2AError.unsupportedOperation("tasks/pushNotificationConfig/delete")
  }

  async *resubscribe(
    params: TaskIdParams,
    _context?: ServerCallContext
  ): AsyncGenerator<
    Task | TaskStatusUpdateEvent | TaskArtifactUpdateEvent,
    void,
    undefined
  > {
    yield* this.streamTask({
      taskId: params.id,
      replayChunks: false,
      emitWorkingFromInitial: false,
    })
  }
}
