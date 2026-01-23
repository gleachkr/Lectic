import type {
  AgentCard,
  Message,
  MessageSendParams,
  Task,
  TaskArtifactUpdateEvent,
  TaskStatusUpdateEvent,
  TaskIdParams,
  TaskPushNotificationConfig,
  TaskQueryParams,
  GetTaskPushNotificationConfigParams,
  ListTaskPushNotificationConfigParams,
  DeleteTaskPushNotificationConfigParams,
  Part,
  TextPart,
} from "@a2a-js/sdk"

import { A2AError, type A2ARequestHandler } from "@a2a-js/sdk/server"
import type { ServerCallContext } from "@a2a-js/sdk/server"

import { resolveA2AContextId } from "./contextId"
import type { PersistedAgentRuntime } from "../agents/persistedRuntime"

function extractTextFromParts(parts: Part[]): string {
  const texts = parts
    .filter((p): p is TextPart => p.kind === "text")
    .map((p) => p.text)

  if (texts.length === 0) return ""
  return texts.join("\n")
}

export class A2AAgentHandler implements A2ARequestHandler {
  private readonly runtime: PersistedAgentRuntime
  private readonly card: AgentCard

  constructor(opt: { runtime: PersistedAgentRuntime; card: AgentCard }) {
    this.runtime = opt.runtime
    this.card = opt.card
  }

  async getAgentCard(): Promise<AgentCard> {
    return this.card
  }

  async getAuthenticatedExtendedAgentCard(
    _context?: ServerCallContext
  ): Promise<AgentCard> {
    throw A2AError.unsupportedOperation("agent/getAuthenticatedExtendedCard")
  }

  async sendMessage(
    params: MessageSendParams,
    _context?: ServerCallContext
  ): Promise<Message | Task> {
    const incoming = params.message

    let contextId: string
    try {
      contextId = resolveA2AContextId(incoming.contextId)
    } catch (e) {
      throw A2AError.invalidParams(
        e instanceof Error ? e.message : "Invalid contextId"
      )
    }

    const userText = extractTextFromParts(incoming.parts)

    const assistantText = await this.runtime.runBlockingTurn({
      contextId,
      userText,
    })

    const out: Message = {
      kind: "message",
      role: "agent",
      messageId: crypto.randomUUID(),
      contextId,
      parts: [{ kind: "text", text: assistantText }],
    }

    return out
  }

  async *sendMessageStream(
    params: MessageSendParams,
    _context?: ServerCallContext
  ): AsyncGenerator<
    Message | Task | TaskStatusUpdateEvent | TaskArtifactUpdateEvent,
    void,
    undefined
  > {
    const incoming = params.message

    let contextId: string
    try {
      contextId = resolveA2AContextId(incoming.contextId)
    } catch (e) {
      throw A2AError.invalidParams(
        e instanceof Error ? e.message : "Invalid contextId"
      )
    }

    const taskId = crypto.randomUUID()

    const userMessage: Message = {
      ...incoming,
      contextId,
      taskId,
      role: "user",
    }

    const task: Task = {
      kind: "task",
      id: taskId,
      contextId,
      status: {
        state: "submitted",
        timestamp: new Date().toISOString(),
      },
      history: [userMessage],
    }

    yield task

    const userText = extractTextFromParts(incoming.parts)

    let assistantText = ""

    for await (const chunk of this.runtime.runStreamingTurn({
      contextId,
      userText,
    })) {
      assistantText += chunk

      const ev: TaskArtifactUpdateEvent = {
        kind: "artifact-update",
        taskId,
        contextId,
        append: true,
        artifact: {
          artifactId: "assistant-text",
          parts: [{ kind: "text", text: chunk }],
        },
      }

      yield ev
    }

    const assistantMessage: Message = {
      kind: "message",
      role: "agent",
      messageId: crypto.randomUUID(),
      taskId,
      contextId,
      parts: [{ kind: "text", text: assistantText }],
    }

    const statusUpdate: TaskStatusUpdateEvent = {
      kind: "status-update",
      taskId,
      contextId,
      final: true,
      status: {
        state: "input-required",
        timestamp: new Date().toISOString(),
        message: assistantMessage,
      },
    }

    yield statusUpdate
  }

  async getTask(
    _params: TaskQueryParams,
    _context?: ServerCallContext
  ): Promise<Task> {
    throw A2AError.unsupportedOperation("tasks/get")
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
    _params: TaskIdParams,
    _context?: ServerCallContext
  ): AsyncGenerator<
    Task | TaskStatusUpdateEvent | TaskArtifactUpdateEvent,
    void,
    undefined
  > {
    throw A2AError.unsupportedOperation("tasks/resubscribe")
    yield undefined as never
  }
}
