import type {
  AgentCard,
  Message,
  MessageSendParams,
  Part,
  TextPart,
} from "@a2a-js/sdk"

import { 
    ClientFactory, 
    type Client as A2AClient 
} from "@a2a-js/sdk/client"

import { Tool, ToolCallResult } from "../types/tool"
import type { JSONSchema } from "../types/schema"
import { isHookSpecList, type HookSpec } from "../types/hook"
import { isObjectRecord } from "../types/guards"

export type A2AToolSpec = {
  a2a: string
  name?: string
  usage?: string
  stream?: boolean
  hooks?: HookSpec[]
}

export function isA2AToolSpec(raw: unknown): raw is A2AToolSpec {
  return (
    raw !== null &&
    typeof raw === "object" &&
    "a2a" in raw &&
    typeof raw.a2a === "string" &&
    ("name" in raw ? typeof raw.name === "string" : true) &&
    ("usage" in raw ? typeof raw.usage === "string" : true) &&
    ("stream" in raw ? typeof raw.stream === "boolean" : true) &&
    ("hooks" in raw ? isHookSpecList(raw.hooks) : true)
  )
}

type ClientEntry = {
  client: A2AClient
  card: AgentCard
}

function isKinded(v: unknown): v is Record<string, unknown> & {
  kind: string
} {
  return isObjectRecord(v) && typeof v["kind"] === "string"
}

function partsToText(parts: Part[]): string {
  const texts = parts
    .filter((p): p is TextPart => p.kind === "text")
    .map((p) => p.text)

  return texts.join("")
}

function extractMessageText(message: Message): string {
  return partsToText(message.parts)
}

export class A2ATool extends Tool {
  name: string
  kind = "a2a"

  private readonly baseUrl: string
  private readonly streamDefault: boolean

  private static count = 0
  private static clientByUrl: Record<string, Promise<ClientEntry>> = {}

  constructor(spec: A2AToolSpec) {
    super(spec.hooks)

    this.name = spec.name ?? `a2a_tool_${A2ATool.count}`
    this.baseUrl = spec.a2a
    this.streamDefault = spec.stream ?? true

    A2ATool.count++

    const usage = spec.usage ? `\n\n${spec.usage}` : ""

    this.description =
      "Use this tool to send a message to a remote A2A agent." +
      " To continue the same conversation, pass the same contextId" +
      " (and taskId if present) returned by earlier calls." +
      usage
  }

  description: string

  parameters: { [key: string]: JSONSchema } = {
    text: {
      type: "string",
      description: "The user text to send to the A2A agent.",
    },
    contextId: {
      anyOf: [
        {
          type: "string",
          description:
            "A2A contextId to continue an existing conversation. " +
            "If omitted, a new conversation is started.",
        },
        { type: "null" },
      ],
      description: "Conversation context id (optional).",
    },
    taskId: {
      anyOf: [
        {
          type: "string",
          description:
            "A2A taskId to continue an existing task (rarely needed).",
        },
        { type: "null" },
      ],
      description: "Task id (optional).",
    },
    stream: {
      anyOf: [
        { type: "boolean", description: "Use streaming if true." },
        { type: "null" },
      ],
      description: "Override streaming behavior.",
    },
  }

  required = ["text"]

  private async getClientEntry(): Promise<ClientEntry> {
    const key = this.baseUrl

    if (!(key in A2ATool.clientByUrl)) {
      A2ATool.clientByUrl[key] = (async () => {
        const factory = new ClientFactory()

        const client = await factory.createFromUrl(this.baseUrl)
        const card = await client.getAgentCard()

        return { client, card }
      })()
    }

    return A2ATool.clientByUrl[key]
  }

  private async sendBlocking(
    client: A2AClient,
    params: MessageSendParams
  ): Promise<{ text: string; contextId?: string; taskId?: string }> {
    const result = await client.sendMessage(params)

    if (!isKinded(result)) {
      throw new Error(`Unexpected A2A response: ${JSON.stringify(result)}`)
    }

    if (result.kind === "message") {
      const msg = result
      return {
        text: extractMessageText(msg),
        contextId: msg.contextId,
        taskId: msg.taskId,
      }
    }

    if (result.kind === "task") {
      const task = result
      const ctx = task.contextId
      const tid = task.id

      const statusMsg = task.status?.message
      if (statusMsg && statusMsg.kind === "message") {
        return {
          text: extractMessageText(statusMsg),
          contextId: ctx,
          taskId: tid,
        }
      }

      return {
        text: JSON.stringify(task),
        contextId: ctx,
        taskId: tid,
      }
    }

    throw new Error(`Unexpected A2A response kind: ${JSON.stringify(result)}`)
  }

  private async sendStreaming(
    client: A2AClient,
    params: MessageSendParams
  ): Promise<{ text: string; contextId?: string; taskId?: string }> {
    const stream = client.sendMessageStream(params)

    let text = ""
    let contextId: string | undefined
    let taskId: string | undefined

    for await (const eventRaw of stream) {
      if (!isKinded(eventRaw)) continue

      if (eventRaw.kind === "message") {
        const msg = eventRaw
        return {
          text: extractMessageText(msg),
          contextId: msg.contextId,
          taskId: msg.taskId,
        }
      }

      if (eventRaw.kind === "task") {
        const task = eventRaw
        contextId = task.contextId
        taskId = task.id
        continue
      }

      if (eventRaw.kind === "artifact-update") {
        const upd = eventRaw
        contextId = upd.contextId
        taskId = upd.taskId

        const chunk = partsToText(upd.artifact.parts)
        if (upd.append) text += chunk
        else text = chunk

        continue
      }

      if (eventRaw.kind === "status-update") {
        const upd = eventRaw
        contextId = upd.contextId
        taskId = upd.taskId

        const msg = upd.status?.message
        if (msg && msg.kind === "message") {
          text = extractMessageText(msg)
        }

        if (upd.final) {
          return { text, contextId, taskId }
        }
      }
    }

    if (text.length > 0) {
      return { text, contextId, taskId }
    }

    throw new Error("A2A stream ended without a final response")
  }

  async call(args: {
    text: string
    contextId?: string | null
    taskId?: string | null
    stream?: boolean | null
  }): Promise<ToolCallResult[]> {
    this.validateArguments(args)

    const entry = await this.getClientEntry()

    const contextId = args.contextId === null ? undefined : args.contextId
    const taskId = args.taskId === null ? undefined : args.taskId

    const wantStream = args.stream ?? this.streamDefault

    const params: MessageSendParams = {
      message: {
        kind: "message",
        role: "user",
        messageId: crypto.randomUUID(),
        contextId,
        taskId,
        parts: [{ kind: "text", text: args.text }],
      },
    }

    const { text, contextId: outContextId, taskId: outTaskId } =
      wantStream
        ? await this.sendStreaming(entry.client, params)
        : await this.sendBlocking(entry.client, params)

    const details = {
      agent: entry.card.name,
      baseUrl: this.baseUrl,
      streaming: wantStream,
      contextId: outContextId,
      taskId: outTaskId,
    }

    return [
      new ToolCallResult(text, "text/plain"),
      new ToolCallResult(JSON.stringify(details, null, 2), "application/json"),
    ]
  }
}
