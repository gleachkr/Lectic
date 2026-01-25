import { createWriteStream } from "node:fs"
import { mkdir, readFile, realpath } from "node:fs/promises"
import { dirname, join } from "node:path"
import * as YAML from "yaml"
import { getBody, bodyToMessages } from "../parsing/parse"
import { getBackend } from "../backends/util"
import { Lectic, LecticBody, LecticHeader, type LecticHeaderSpec }
  from "../types/lectic"
import { UserMessage } from "../types/message"
import { KeyedMutex } from "../utils/mutex"

export type TranscriptPathParams = {
  stateDir: string
  workspaceKey: string
  agentId: string
  contextId: string
}

export function a2aTranscriptPath(p: TranscriptPathParams): string {
  return join(p.stateDir, "a2a", p.workspaceKey, p.agentId, `${p.contextId}.lec`)
}

export async function computeWorkspaceKey(root: string): Promise<string> {
  const resolved = await realpath(root)
  return String(Bun.hash(resolved))
}

function isMessageOnlyChunk(chunk: string): boolean {
  const trimmed = chunk.trimStart()
  return (
    !trimmed.startsWith("<tool-call") &&
    !trimmed.startsWith("<inline-attachment")
  )
}

async function writeChunk(
  stream: ReturnType<typeof createWriteStream>,
  chunk: string
): Promise<void> {
  const ok = stream.write(chunk)
  if (ok) return

  await new Promise<void>((resolve, reject) => {
    const onDrain = () => {
      cleanup()
      resolve()
    }
    const onError = (e: unknown) => {
      cleanup()
      reject(e)
    }
    const cleanup = () => {
      stream.off("drain", onDrain)
      stream.off("error", onError)
    }

    stream.on("drain", onDrain)
    stream.on("error", onError)
  })
}

function ensureTrailingNewlines(text: string, count: number): string {
  const m = /\n*$/.exec(text)
  const have = m ? m[0].length : 0
  return have >= count ? "" : "\n".repeat(count - have)
}

const GLOBAL_MUTEX = new KeyedMutex()

export type PersistedAgentRuntimeOptions = {
  agentId: string
  interlocutorName: string
  baseSpec: LecticHeaderSpec
  transcriptRoot: string
  workspaceKey: string
}

export class PersistedAgentRuntime {
  readonly agentId: string
  readonly interlocutorName: string
  readonly baseSpec: LecticHeaderSpec
  readonly transcriptRoot: string
  readonly workspaceKey: string

  constructor(opt: PersistedAgentRuntimeOptions) {
    this.agentId = opt.agentId
    this.interlocutorName = opt.interlocutorName
    this.baseSpec = opt.baseSpec
    this.transcriptRoot = opt.transcriptRoot
    this.workspaceKey = opt.workspaceKey
  }

  transcriptPath(contextId: string): string {
    return join(
        this.transcriptRoot, 
        this.workspaceKey, 
        this.agentId, 
        `${contextId}.lec`)
  }

  async ensureTranscriptFile(path: string): Promise<void> {
    await mkdir(dirname(path), { recursive: true })

    try {
      await readFile(path)
    } catch {
      // YAML.stringify has a terminating newline
      await Bun.write(path, `---\n${YAML.stringify({interlocutor: { name : this.interlocutorName }})}---`)
    }
  }

  async *runStreamingTurn(opt: {
    contextId: string
    userText: string
  }): AsyncGenerator<string, void, undefined> {
    const lockKey = `${this.agentId}:${opt.contextId}`
    const release = await GLOBAL_MUTEX.acquire(lockKey)

    try {
      const transcriptPath = this.transcriptPath(opt.contextId)
      await this.ensureTranscriptFile(transcriptPath)

      const beforeText = await readFile(transcriptPath, "utf8")

      const header = new LecticHeader(this.baseSpec)
      header.setSpeaker(this.interlocutorName)

      const beforeBody = getBody(beforeText)
      const messages = bodyToMessages(beforeBody, header)
      messages.push(new UserMessage({ content: opt.userText }))

      const body = new LecticBody({ messages, raw: beforeText })
      const lectic = new Lectic({ header, body })

      // Don't run processMessages: agents should not handle directives

      await lectic.header.initialize()

      const backend = getBackend(lectic.header.interlocutor)

      const userText = opt.userText.replace(/\r\n/g, "\n").trimEnd()
      const prefix =
        ensureTrailingNewlines(beforeText, 2) +
        userText +
        "\n\n" +
        `:::${lectic.header.interlocutor.name}\n\n`

      const stream = createWriteStream(transcriptPath, { flags: "a" })
      let opened = false

      try {
        await writeChunk(stream, prefix)
        opened = true
        lectic.body.raw += prefix

        for await (const chunk of backend.evaluate(lectic)) {
          await writeChunk(stream, chunk)
          lectic.body.raw += chunk
          if (isMessageOnlyChunk(chunk)) yield chunk
        }
      } catch (e) {
        if (opened) {
          const msg = e instanceof Error ? e.message : String(e)
          const errBlock = `\n\n<error>\n${msg}\n</error>`
          await writeChunk(stream, errBlock)
          lectic.body.raw += errBlock
        }
        throw e
      } finally {
        if (opened) {
          const footer = "\n\n:::\n"
          await writeChunk(stream, footer)
          lectic.body.raw += footer
        }
        stream.end()
      }
    } finally {
      release()
    }
  }

  async runBlockingTurn(opt: {
    contextId: string
    userText: string
  }): Promise<string> {
    let out = ""
    for await (const chunk of this.runStreamingTurn(opt)) {
      out += chunk
    }
    return out
  }
}
