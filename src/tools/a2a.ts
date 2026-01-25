import type {
  AgentCard,
  Message,
  MessageSendParams,
  Part,
  TextPart,
  FilePart,
  DataPart,
} from "@a2a-js/sdk"

import { join } from "node:path"

import {
  ClientFactory,
  ClientFactoryOptions,
  JsonRpcTransportFactory,
  type Client as A2AClient,
} from "@a2a-js/sdk/client"

import { Tool, ToolCallResult } from "../types/tool"
import type { JSONSchema } from "../types/schema"
import { isHookSpecList, type HookSpec } from "../types/hook"
import { isObjectRecord } from "../types/guards"
import { lecticCacheDir } from "../utils/xdg"
import { cachedJson, writeJsonCacheFile }
  from "../utils/cache"
import { withTimeout } from "../utils/timeout"
import {
  createFetchWithHeaderSources,
} from "../utils/fetchWithHeaders"

export type A2AToolSpec = {
  a2a: string
  name?: string
  usage?: string
  stream?: boolean

  // Like MCP Streamable HTTP headers: supports file:/exec: via loadFrom.
  // Values are loaded at request time.
  headers?: Record<string, string>

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
    ("headers" in raw
      ? isObjectRecord(raw.headers) &&
        Object.values(raw.headers).every((v) => typeof v === "string")
      : true) &&
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

type ExtractedParts = {
  text: string
  results: ToolCallResult[]
}

function filePartToResult(part: FilePart): ToolCallResult | null {
  const f = part.file
  const mime = f.mimeType || "application/octet-stream"

  if ("bytes" in f && typeof f.bytes === "string" && f.bytes.length > 0) {
    const uri = `data:${mime};base64,${f.bytes}`
    return new ToolCallResult(uri, mime)
  }

  if ("uri" in f && typeof f.uri === "string" && f.uri.length > 0) {
    return new ToolCallResult(f.uri, mime)
  }

  return null
}

function dataPartToResult(part: DataPart): ToolCallResult {
  // DataPart is structured data. Surface it explicitly rather than forcing
  // the caller to reverse-engineer the original A2A event.
  return new ToolCallResult(
    JSON.stringify(part.data, null, 2),
    "application/json",
  )
}

function extractParts(parts: Part[]): ExtractedParts {
  const results: ToolCallResult[] = []

  for (const p of parts) {
    if (p.kind === "file") {
      const r = filePartToResult(p)
      if (r) results.push(r)
      continue
    }

    if (p.kind === "data") {
      results.push(dataPartToResult(p))
      continue
    }
  }

  return { text: partsToText(parts), results }
}

function extractMessageParts(message: Message): ExtractedParts {
  return extractParts(message.parts)
}

export class A2ATool extends Tool {
  name: string
  kind = "a2a"

  private readonly baseUrl: string
  private readonly clientBaseUrl: string
  private readonly streamDefault: boolean
  private readonly baseDescription: string
  private readonly headerSources?: Record<string, string>

  private card?: AgentCard
  private initDone = false

  private static count = 0
  private static clientByKey: Record<string, Promise<ClientEntry>> = {}

  constructor(spec: A2AToolSpec) {
    super(spec.hooks)

    this.name = spec.name ?? `a2a_tool_${A2ATool.count}`
    this.baseUrl = spec.a2a
    this.clientBaseUrl = spec.a2a.endsWith("/") ? spec.a2a : `${spec.a2a}/`
    this.streamDefault = spec.stream ?? true
    this.headerSources = spec.headers

    A2ATool.count++

    const usage = spec.usage ? `\n\n${spec.usage}` : ""

    this.baseDescription =
      "Use this tool to send a message to a remote A2A agent." +
      " To continue the same conversation, pass the same contextId" +
      " (and taskId if present) returned by earlier calls." +
      usage

    this.description = this.baseDescription
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

  private agentCardCachePath(): string {
    const hashed = Bun.hash(this.clientBaseUrl)
    return join(lecticCacheDir(), "a2a", "agent-cards", `${hashed}.json`)
  }

  private formatAgentCard(card: AgentCard): string {
    const lines: string[] = []

    lines.push("Remote agent (from agent card):")
    lines.push(`- baseUrl: ${this.baseUrl}`)
    lines.push(`- name: ${card.name}`)

    const headerNames = Object.keys(this.headerSources ?? {})
    if (headerNames.length > 0) {
      lines.push(`- requestHeaders: ${headerNames.join(", ")}`)
    }

    const desc = card.description
    if (desc) {
      lines.push(`- description: ${desc}`)
    }

    const version = card.version
    if (version) {
      lines.push(`- version: ${version}`)
    }

    const protocolVersion = card.protocolVersion
    if (protocolVersion) {
      lines.push(`- protocolVersion: ${protocolVersion}`)
    }

    const providerOrg = card.provider?.organization
    if (providerOrg) {
      lines.push(`- provider: ${providerOrg}`)
    }

    const sec = (card as unknown as { security?: unknown }).security
    if (Array.isArray(sec) && sec.length > 0) {
      lines.push("- security:")

      for (const entry of sec.slice(0, 5)) {
        if (!isObjectRecord(entry)) continue
        const schemes = Object.entries(entry)
          .map(([k, v]) => {
            const scopes = Array.isArray(v)
              ? v.filter((s) => typeof s === "string")
              : []

            if (scopes.length > 0) return `${k} (${scopes.join(", ")})`
            return k
          })
          .join(" + ")

        if (schemes) lines.push(`  - ${schemes}`)
      }

      if (sec.length > 5) {
        lines.push(`  - ... (${sec.length - 5} more)`)
      }

      if (headerNames.length === 0) {
        lines.push(
          "- warning: agent declares security requirements; " +
            "configure request headers for this tool or calls may fail"
        )
      }
    }

    const skills = card.skills
    if (skills && skills.length > 0) {
      lines.push("- skills:")

      for (const skill of skills.slice(0, 10)) {
        const name = skill.name ?? skill.id ?? "unknown"
        const sdesc = skill.description

        if (sdesc) {
          lines.push(`  - ${name}: ${sdesc}`)
        } else {
          lines.push(`  - ${name}`)
        }
      }

      if (skills.length > 10) {
        lines.push(`  - ... (${skills.length - 10} more)`)
      }
    }

    return lines.join("\n")
  }

  private createClientFactory(): ClientFactory {
    const customFetch = createFetchWithHeaderSources(this.headerSources)

    if (customFetch === fetch) {
      return new ClientFactory()
    }

    const transportFactory = new JsonRpcTransportFactory({
      fetchImpl: customFetch,
    })

    const factoryOptions = ClientFactoryOptions.createFrom(
      ClientFactoryOptions.default,
      { transports: [transportFactory] },
    )

    return new ClientFactory(factoryOptions)
  }

  private async fetchAgentCard(): Promise<AgentCard> {
    const factory = this.createClientFactory()
    const client = await factory.createFromUrl(this.clientBaseUrl)
    return client.getAgentCard()
  }

  async init(): Promise<void> {
    if (this.initDone) return
    this.initDone = true

    const cachePath = this.agentCardCachePath()
    const timeoutSeconds = 2

    try {
      const { value: card } = await cachedJson<AgentCard>({
        path: cachePath,
        load: async () => {
          const card = await withTimeout(
            this.fetchAgentCard(),
            timeoutSeconds,
            "A2A agent card",
          )

          this.card = card
          return card
        },
      })

      this.card = card
      this.description =
        `${this.baseDescription}\n\n${this.formatAgentCard(card)}`
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      this.description =
        `${this.baseDescription}\n\n` +
        `Remote agent info error: ${msg}. ` +
        `No agent info available.`
    }
  }

  private clientCacheKey(): string {
    return String(
      Bun.hash(
        JSON.stringify({
          baseUrl: this.clientBaseUrl,
          headers: this.headerSources ?? null,
        })
      )
    )
  }

  private async getClientEntry(): Promise<ClientEntry> {
    const key = this.clientCacheKey()

    if (!(key in A2ATool.clientByKey)) {
      A2ATool.clientByKey[key] = (async () => {
        const factory = this.createClientFactory()

        const client = await factory.createFromUrl(this.clientBaseUrl)

        const cachedCard = this.card
        const hadCard = cachedCard !== undefined
        const card = hadCard ? cachedCard : await client.getAgentCard()
        this.card = card

        if (!hadCard) {
          try {
            await writeJsonCacheFile({
              path: this.agentCardCachePath(),
              value: card,
            })
          } catch {
            // Ignore cache write errors.
          }
        }

        return { client, card }
      })()
    }

    return A2ATool.clientByKey[key]
  }

  private async sendBlocking(
    client: A2AClient,
    params: MessageSendParams
  ): Promise<{
    text: string
    results: ToolCallResult[]
    contextId?: string
    taskId?: string
  }> {
    const result = await client.sendMessage(params)

    const results: ToolCallResult[] = []

    if (!isKinded(result)) {
      throw new Error(`Unexpected A2A response: ${JSON.stringify(result)}`)
    }

    if (result.kind === "message") {
      const msg = result
      const extracted = extractMessageParts(msg)
      results.push(...extracted.results)

      return {
        text: extracted.text,
        results,
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
        const extracted = extractMessageParts(statusMsg)
        results.push(...extracted.results)

        return {
          text: extracted.text,
          results,
          contextId: ctx,
          taskId: tid,
        }
      }

      return {
        text: JSON.stringify(task),
        results,
        contextId: ctx,
        taskId: tid,
      }
    }

    throw new Error(`Unexpected A2A response kind: ${JSON.stringify(result)}`)
  }

  private async sendStreaming(
    client: A2AClient,
    params: MessageSendParams
  ): Promise<{
    text: string
    results: ToolCallResult[]
    contextId?: string
    taskId?: string
  }> {
    const stream = client.sendMessageStream(params)

    let text = ""
    const results: ToolCallResult[] = []
    let contextId: string | undefined
    let taskId: string | undefined

    for await (const eventRaw of stream) {
      if (!isKinded(eventRaw)) continue

      if (eventRaw.kind === "message") {
        const msg = eventRaw
        const extracted = extractMessageParts(msg)
        results.push(...extracted.results)

        return {
          text: extracted.text,
          results,
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

        const extracted = extractParts(upd.artifact.parts)
        results.push(...extracted.results)

        if (extracted.text.length > 0) {
          if (upd.append) text += extracted.text
          else text = extracted.text
        }

        continue
      }

      if (eventRaw.kind === "status-update") {
        const upd = eventRaw
        contextId = upd.contextId
        taskId = upd.taskId

        const msg = upd.status?.message
        if (msg && msg.kind === "message") {
          const extracted = extractMessageParts(msg)
          results.push(...extracted.results)
          text = extracted.text
        }

        if (upd.final) {
          return { text, results, contextId, taskId }
        }
      }
    }

    if (text.length > 0 || results.length > 0) {
      return { text, results, contextId, taskId }
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

    const {
      text,
      results: partResults,
      contextId: outContextId,
      taskId: outTaskId,
    } =
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
      ...partResults,
      new ToolCallResult(JSON.stringify(details, null, 2), "application/json"),
    ]
  }
}
