import type {
  AgentCard,
  Message,
  MessageSendParams,
  Part,
  TextPart,
  FilePart,
  DataPart,
  Task,
  TaskState,
  Artifact,
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

  // When streaming, max seconds to wait for a terminal event before
  // returning early with taskId/contextId.
  maxWaitSeconds?: number

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
    ("maxWaitSeconds" in raw
      ? typeof raw.maxWaitSeconds === "number" &&
        Number.isFinite(raw.maxWaitSeconds) &&
        raw.maxWaitSeconds >= 0
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

function isTaskFinalEnough(state: TaskState): boolean {
  return (
    state === "completed" ||
    state === "failed" ||
    state === "canceled" ||
    state === "rejected" ||
    state === "input-required" ||
    state === "auth-required"
  )
}

function isTaskPollable(state: TaskState): boolean {
  return state === "submitted" || state === "working"
}

function extractArtifacts(artifacts: Artifact[] | undefined): ExtractedParts {
  const results: ToolCallResult[] = []
  const texts: string[] = []

  for (const a of artifacts ?? []) {
    const extracted = extractParts(a.parts)
    results.push(...extracted.results)
    if (extracted.text.length > 0) texts.push(extracted.text)
  }

  return { text: texts.join("\n"), results }
}

function extractTaskOutput(task: Task): ExtractedParts {
  const results: ToolCallResult[] = []

  const statusMsg = task.status?.message
  const fromStatus =
    statusMsg && statusMsg.kind === "message"
      ? extractMessageParts(statusMsg)
      : { text: "", results: [] }

  results.push(...fromStatus.results)

  const fromArtifacts = extractArtifacts(task.artifacts)
  results.push(...fromArtifacts.results)

  const text = fromStatus.text.length > 0 ? fromStatus.text : fromArtifacts.text

  return { text, results }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

const DEFAULT_MAX_WAIT_SECONDS = 5

export class A2ATool extends Tool {
  name: string
  kind = "a2a"

  private readonly baseUrl: string
  private readonly clientBaseUrl: string
  private readonly streamDefault: boolean
  private readonly maxWaitSecondsDefault: number
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
    this.maxWaitSecondsDefault =
      spec.maxWaitSeconds ?? DEFAULT_MAX_WAIT_SECONDS
    this.headerSources = spec.headers

    A2ATool.count++

    const usage = spec.usage ? `\n\n${spec.usage}` : ""

    this.baseDescription =
      "Use this tool to call a remote A2A agent." +
      " Use op=sendMsg to send user text." +
      " Use op=getTask to resume/poll a long-running task via tasks/get." +
      " To continue the same conversation, pass the same contextId returned" +
      " by earlier calls." +
      usage

    this.description = this.baseDescription
  }

  description: string

  parameters: { [key: string]: JSONSchema } = {
    op: {
      type: "string",
      enum: ["sendMsg", "getTask"],
      description:
        "Operation mode. sendMsg = message/send or message/sendStream. " +
        "getTask = tasks/get polling for long-running tasks.",
    },
    text: {
      type: "string",
      description:
        "User text to send to the A2A agent (required when op=sendMsg).",
    },
    contextId: {
      type: "string",
      description:
        "A2A contextId to continue an existing conversation (optional).",
    },
    taskId: {
      type: "string",
      description:
        "A2A taskId. Required when op=getTask; optional when op=sendMsg.",
    },
    stream: {
      type: "boolean",
      description: "Override streaming behavior (send only).",
    },
    maxWaitSeconds: {
      type: "number",
      minimum: 0,
      description:
        "Max seconds to wait for a streaming call to finish. " +
        "If exceeded, the tool returns early with taskId/contextId so " +
        "you can resume via op=getTask.",
    },
  }

  required = ["op"]

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

    const sec = card.security
    if (Array.isArray(sec) && sec.length > 0) {
      lines.push("- security:")

      for (const entry of sec.slice(0, 5)) {
        const schemes = Object.entries(entry)
          .map(([k, scopes]) => {
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

  private async pollTask(
    client: A2AClient,
    startTask: Task,
  ): Promise<{ task: Task; polls: number; pollError?: string }> {
    const tid = startTask.id

    let task = startTask

    const pollIntervalMs = 200
    const pollMaxPolls = 20
    const pollMaxMs = 5000

    const start = Date.now()
    let polls = 0
    let pollError: string | undefined

    while (isTaskPollable(task.status.state)) {
      if (polls >= pollMaxPolls) break
      if (Date.now() - start >= pollMaxMs) break

      try {
        task = await client.getTask({ id: tid })
        polls++
      } catch (e) {
        pollError = e instanceof Error ? e.message : String(e)
        break
      }

      if (!isTaskPollable(task.status.state)) break
      await delay(pollIntervalMs)
    }

    return { task, polls, pollError }
  }

  private async getTaskBlocking(
    client: A2AClient,
    taskId: string,
  ): Promise<{
    text: string
    results: ToolCallResult[]
    contextId?: string
    taskId?: string
    taskState?: TaskState
  }> {
    const results: ToolCallResult[] = []

    const startTask = await client.getTask({ id: taskId })
    const { task, polls, pollError } = await this.pollTask(client, startTask)

    const extracted = extractTaskOutput(task)
    results.push(...extracted.results)

    let text = extracted.text

    if (text.length === 0) {
      if (pollError) {
        text =
          `A2A task ${taskId} returned without a message. ` +
          `Polling tasks/get failed: ${pollError}`
      } else if (isTaskFinalEnough(task.status.state)) {
        text =
          `A2A task ${taskId} finished with state ${task.status.state}, ` +
          "but did not provide a status message."
      } else if (isTaskPollable(task.status.state)) {
        text =
          `A2A task ${taskId} is still ${task.status.state} ` +
          `after ${polls} polls. You can retry later using op=getTask ` +
          "with the returned taskId."
      } else {
        text =
          `A2A task ${taskId} reached state ${task.status.state} ` +
          "without providing a status message."
      }
    }

    return {
      text,
      results,
      contextId: task.contextId,
      taskId: task.id,
      taskState: task.status.state,
    }
  }

  private async sendBlocking(
    client: A2AClient,
    params: MessageSendParams,
  ): Promise<{
    text: string
    results: ToolCallResult[]
    contextId?: string
    taskId?: string
    taskState?: TaskState
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
      const startTask = result as Task
      const tid = startTask.id

      let task = startTask
      let polls = 0
      let pollError: string | undefined

      if (isTaskPollable(task.status.state)) {
        const polled = await this.pollTask(client, startTask)
        task = polled.task
        polls = polled.polls
        pollError = polled.pollError
      }

      const extracted = extractTaskOutput(task)
      results.push(...extracted.results)

      let text = extracted.text

      if (text.length === 0) {
        if (pollError) {
          text =
            `A2A task ${tid} returned without a message. ` +
            `Polling tasks/get failed: ${pollError}`
        } else if (isTaskFinalEnough(task.status.state)) {
          text =
            `A2A task ${tid} finished with state ${task.status.state}, ` +
            "but did not provide a status message."
        } else if (isTaskPollable(task.status.state)) {
          text =
            `A2A task ${tid} is still ${task.status.state} ` +
            `after ${polls} polls. You can retry later using op=getTask ` +
            "with the returned taskId."
        } else {
          text =
            `A2A task ${tid} reached state ${task.status.state} ` +
            "without providing a status message."
        }
      }

      return {
        text,
        results,
        contextId: task.contextId,
        taskId: task.id,
        taskState: task.status.state,
      }
    }

    throw new Error(`Unexpected A2A response kind: ${JSON.stringify(result)}`)
  }

  private async sendStreaming(
    client: A2AClient,
    params: MessageSendParams,
    maxWaitSeconds: number,
  ): Promise<{
    text: string
    results: ToolCallResult[]
    contextId?: string
    taskId?: string
    taskState?: TaskState
  }> {
    // Important:
    // We use an AbortController so we can return early without blocking on
    // the underlying stream shutdown. Awaiting iter.return() can block until
    // the remote agent finishes streaming.
    const abort = new AbortController()

    const stream = client.sendMessageStream(params, { signal: abort.signal })
    type StreamData<T> =
      T extends AsyncGenerator<infer Y, infer _, infer _> ? Y : never
    const iter = stream[Symbol.asyncIterator]()

    let text = ""
    const results: ToolCallResult[] = []
    let contextId: string | undefined
    let taskId: string | undefined
    let taskState: TaskState | undefined

    const processEvent = (eventRaw: StreamData<typeof stream>): {
      text: string
      results: ToolCallResult[]
      contextId?: string
      taskId?: string
      taskState?: TaskState
    } | null => {
      if (!isKinded(eventRaw)) return null

      if (eventRaw.kind === "message") {
        const msg = eventRaw
        const extracted = extractMessageParts(msg)
        results.push(...extracted.results)

        return {
          text: extracted.text,
          results,
          contextId: msg.contextId,
          taskId: msg.taskId,
          taskState,
        }
      }

      if (eventRaw.kind === "task") {
        const task = eventRaw
        contextId = task.contextId
        taskId = task.id
        taskState = task.status.state
        return null
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

        return null
      }

      if (eventRaw.kind === "status-update") {
        const upd = eventRaw
        contextId = upd.contextId
        taskId = upd.taskId

        const msg = upd.status?.message
        if (msg && isKinded(msg) && msg.kind === "message") {
          const extracted = extractMessageParts(msg)
          results.push(...extracted.results)
          text = extracted.text
        }

        taskState = upd.status.state

        if (upd.final) {
          return { text, results, contextId, taskId, taskState }
        }

        return null
      }

      return null
    }

    const timeoutResult = (): {
      text: string
      results: ToolCallResult[]
      contextId?: string
      taskId?: string
      taskState?: TaskState
    } => {
      const state = taskState ?? "working"

      if (text.length > 0) {
        return { text, results, contextId, taskId, taskState }
      }

      if (taskId) {
        return {
          text:
            `A2A task ${taskId} is still ${state} after ` +
            `${maxWaitSeconds} seconds. ` +
            "You can retry later using op=getTask with this taskId.",
          results,
          contextId,
          taskId,
          taskState,
        }
      }

      return {
        text:
          `A2A stream did not finish within ${maxWaitSeconds} seconds.`,
        results,
        contextId,
        taskId,
        taskState,
      }
    }

    let timer: ReturnType<typeof setTimeout> | undefined
    let timeoutHit = false

    try {
      const first = await withTimeout(iter.next(), 2, "A2A stream initial event")

      if (first.done) {
        throw new Error("A2A stream ended without any events")
      }

      const firstRes = processEvent(first.value)
      if (firstRes) return firstRes

      const maxWaitMs = Math.floor(Math.max(0, maxWaitSeconds) * 1000)

      if (maxWaitMs <= 0) {
        timeoutHit = true
        abort.abort()
        return timeoutResult()
      }

      timer = setTimeout(() => {
        timeoutHit = true
        abort.abort()
      }, maxWaitMs)

      while (true) {
        const next = await iter.next()

        if (next.done) {
          break
        }

        const res = processEvent(next.value)
        if (res) return res
      }
    } catch (e) {
      if (timeoutHit) {
        if (isObjectRecord(e) && e["name"] === "AbortError") {
          return timeoutResult()
        }
      }

      throw e
    } finally {
      if (timer) clearTimeout(timer)

      // Don't await: it can block until the remote stream completes.
      void iter.return?.().catch(() => {})
    }

    if (text.length > 0 || results.length > 0) {
      return { text, results, contextId, taskId, taskState }
    }

    throw new Error("A2A stream ended without a final response")
  }

  async call(args: {
    op: "sendMsg" | "getTask"
    text?: string
    contextId?: string
    taskId?: string
    stream?: boolean
    maxWaitSeconds?: number
  }): Promise<ToolCallResult[]> {
    this.validateArguments(args)

    const entry = await this.getClientEntry()

    const op = args.op

    if (op === "getTask") {
      if (!args.taskId) {
        throw new Error("Missing required argument for op=getTask: taskId")
      }

      const {
        text,
        results: partResults,
        contextId: outContextId,
        taskId: outTaskId,
        taskState: outTaskState,
      } = await this.getTaskBlocking(entry.client, args.taskId)

      const details = {
        agent: entry.card.name,
        baseUrl: this.baseUrl,
        op,
        streaming: false,
        contextId: outContextId,
        taskId: outTaskId,
        taskState: outTaskState,
      }

      return [
        new ToolCallResult(text, "text/plain"),
        ...partResults,
        new ToolCallResult(
          JSON.stringify(details, null, 2),
          "application/json",
        ),
      ]
    }

    if (op === "sendMsg") {
      const contextId = args.contextId
      const taskId = args.taskId

      const wantStream = args.stream ?? this.streamDefault
      const maxWaitSeconds = args.maxWaitSeconds ?? this.maxWaitSecondsDefault

      if (!args.text || args.text.trim().length === 0) {
        throw new Error("Missing required argument for op=sendMsg: text")
      }

      const params: MessageSendParams = {
        message: {
          kind: "message",
          role: "user",
          messageId: Bun.randomUUIDv7(),
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
        taskState: outTaskState,
      } =
        wantStream
          ? await this.sendStreaming(entry.client, params, maxWaitSeconds)
          : await this.sendBlocking(entry.client, params)

      const details = {
        agent: entry.card.name,
        baseUrl: this.baseUrl,
        op,
        streaming: wantStream,
        contextId: outContextId,
        taskId: outTaskId,
        taskState: outTaskState,
      }

      return [
        new ToolCallResult(text, "text/plain"),
        ...partResults,
        new ToolCallResult(JSON.stringify(details, null, 2), "application/json"),
      ]
    }

    throw new Error(`Unknown op: ${op}`)
  }
}
