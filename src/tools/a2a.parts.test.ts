import { describe, expect, test } from "bun:test"

import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type {
  AgentCard,
  Message,
  MessageSendParams,
  Task,
  TaskArtifactUpdateEvent,
  TaskStatusUpdateEvent,
} from "@a2a-js/sdk"
import type { A2ARequestHandler } from "@a2a-js/sdk/server"
import { JsonRpcTransportHandler } from "@a2a-js/sdk/server"

import { startA2AServer, type A2AServerAgent } from "../a2a/a2aServer"
import { A2ATool } from "./a2a"

function mkCard(opt: {
  host: string
  port: number
  agentId: string
  streaming: boolean
}): AgentCard {
  return {
    name: "TestAgent",
    description: "Test agent",
    protocolVersion: "0.3.0",
    version: "0.0.0",
    preferredTransport: "JSONRPC",
    url: `http://${opt.host}:${opt.port}/agents/${opt.agentId}/a2a/jsonrpc`,
    capabilities: {
      streaming: opt.streaming,
      pushNotifications: false,
    },
    defaultInputModes: ["text"],
    defaultOutputModes: ["text"],
    skills: [],
  }
}

function findResult(results: { mimetype: string; content: string }[], mt: string) {
  return results.find((r) => r.mimetype === mt)
}

describe("A2ATool part and artifact surfacing", () => {
  test("surfaces file + data parts from blocking responses", async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), "lectic-a2a-test-"))
    process.env["LECTIC_CACHE"] = cacheDir

    const host = "127.0.0.1"
    const agentId = "test"

    let card!: AgentCard

    const handler: A2ARequestHandler = {
      async getAgentCard(): Promise<AgentCard> {
        return card
      },

      async getAuthenticatedExtendedAgentCard(): Promise<AgentCard> {
        throw new Error("unsupported")
      },

      async sendMessage(
        params: MessageSendParams,
      ): Promise<Message | Task> {
        const ctx = params.message.contextId

        return {
          kind: "message",
          role: "agent",
          messageId: crypto.randomUUID(),
          contextId: ctx,
          parts: [
            { kind: "text", text: "hello" },
            {
              kind: "file",
              file: {
                mimeType: "application/pdf",
                bytes: "aGVsbG8=", // "hello" base64
                name: "doc.pdf",
              },
            },
            { kind: "data", data: { foo: "bar" } },
          ],
        }
      },

      async *sendMessageStream(
        _params: MessageSendParams,
      ): AsyncGenerator<
        Message | Task | TaskStatusUpdateEvent | TaskArtifactUpdateEvent,
        void,
        undefined
      > {
        throw new Error("not used")
        yield undefined as never
      },

      async getTask(): Promise<Task> {
        throw new Error("unsupported")
      },

      async cancelTask(): Promise<Task> {
        throw new Error("unsupported")
      },

      async setTaskPushNotificationConfig() {
        throw new Error("unsupported")
      },

      async getTaskPushNotificationConfig() {
        throw new Error("unsupported")
      },

      async listTaskPushNotificationConfigs() {
        throw new Error("unsupported")
      },

      async deleteTaskPushNotificationConfig() {
        throw new Error("unsupported")
      },

      async *resubscribe() {
        throw new Error("unsupported")
        yield undefined as never
      },
    }

    const agents = new Map<string, A2AServerAgent>()

    const server = startA2AServer({
      host,
      port: 0,
      agents,
    })

    const port = server.port
    if (port === undefined) {
      throw new Error("Expected server.port to be set")
    }

    try {
      card = mkCard({
        host,
        port,
        agentId,
        streaming: false,
      })

      const transport = new JsonRpcTransportHandler(handler)
      agents.set(agentId, { agentId, handler, card, transport })

      const tool = new A2ATool({
        a2a: `http://${host}:${port}/agents/${agentId}`,
        name: "remote",
        stream: false,
      })

      const results = await tool.call({ op: "sendMsg", text: "hi" })

      expect(results[0].mimetype).toBe("text/plain")
      expect(results[0].content).toBe("hello")

      const pdf = findResult(results, "application/pdf")
      expect(pdf).toBeDefined()
      expect(pdf?.content).toBe("data:application/pdf;base64,aGVsbG8=")

      const data = findResult(results, "application/json")
      expect(data).toBeDefined()
      expect(data?.content).toContain('"foo": "bar"')
    } finally {
      void server.stop()
    }
  })

  test("surfaces file parts from artifact updates in streaming", async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), "lectic-a2a-test-"))
    process.env["LECTIC_CACHE"] = cacheDir

    const host = "127.0.0.1"
    const agentId = "test-stream"

    let card!: AgentCard

    const handler: A2ARequestHandler = {
      async getAgentCard(): Promise<AgentCard> {
        return card
      },

      async getAuthenticatedExtendedAgentCard(): Promise<AgentCard> {
        throw new Error("unsupported")
      },

      async sendMessage(
        _params: MessageSendParams,
      ): Promise<Message | Task> {
        throw new Error("not used")
      },

      async *sendMessageStream(
        params: MessageSendParams,
      ): AsyncGenerator<
        Message | Task | TaskStatusUpdateEvent | TaskArtifactUpdateEvent,
        void,
        undefined
      > {
        const ctx = params.message.contextId
        const taskId = crypto.randomUUID()

        const task: Task = {
          kind: "task",
          id: taskId,
          contextId: ctx || crypto.randomUUID(),
          status: { state: "submitted" },
        }

        yield task

        const artifactUpdate: TaskArtifactUpdateEvent = {
          kind: "artifact-update",
          taskId,
          contextId: task.contextId,
          append: false,
          artifact: {
            artifactId: "file",
            parts: [
              {
                kind: "file",
                file: {
                  mimeType: "application/pdf",
                  bytes: "aGVsbG8=",
                  name: "doc.pdf",
                },
              },
            ],
          },
        }

        yield artifactUpdate

        const finalMessage: Message = {
          kind: "message",
          role: "agent",
          messageId: crypto.randomUUID(),
          contextId: task.contextId,
          taskId,
          parts: [{ kind: "text", text: "done" }],
        }

        const statusUpdate: TaskStatusUpdateEvent = {
          kind: "status-update",
          taskId,
          contextId: task.contextId,
          final: true,
          status: {
            state: "input-required",
            message: finalMessage,
          },
        }

        yield statusUpdate
      },

      async getTask(): Promise<Task> {
        throw new Error("unsupported")
      },

      async cancelTask(): Promise<Task> {
        throw new Error("unsupported")
      },

      async setTaskPushNotificationConfig() {
        throw new Error("unsupported")
      },

      async getTaskPushNotificationConfig() {
        throw new Error("unsupported")
      },

      async listTaskPushNotificationConfigs() {
        throw new Error("unsupported")
      },

      async deleteTaskPushNotificationConfig() {
        throw new Error("unsupported")
      },

      async *resubscribe() {
        throw new Error("unsupported")
        yield undefined as never
      },
    }

    const agents = new Map<string, A2AServerAgent>()

    const server = startA2AServer({
      host,
      port: 0,
      agents,
    })

    const port = server.port
    if (port === undefined) {
      throw new Error("Expected server.port to be set")
    }

    try {
      card = mkCard({
        host,
        port,
        agentId,
        streaming: true,
      })

      const transport = new JsonRpcTransportHandler(handler)
      agents.set(agentId, { agentId, handler, card, transport })

      const tool = new A2ATool({
        a2a: `http://${host}:${port}/agents/${agentId}`,
        name: "remote",
        stream: true,
      })

      const results = await tool.call({ op: "sendMsg", text: "hi" })

      expect(results[0].mimetype).toBe("text/plain")
      expect(results[0].content).toBe("done")

      const pdf = findResult(results, "application/pdf")
      expect(pdf).toBeDefined()
      expect(pdf?.content).toBe("data:application/pdf;base64,aGVsbG8=")
    } finally {
      void server.stop()
    }
  })
})
