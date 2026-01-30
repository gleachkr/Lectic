import { AssistantMessage } from "../types/message"
import type { Interlocutor } from "../types/interlocutor"

export type TurnRuntime = {
  interlocutorName: string

  runBlockingTurnRaw(opt: {
    contextId: string
    userText: string
  }): Promise<string>
}

export type TurnRunResult = {
  rawAssistantOutput: string

  // Agent-visible text chunks, split by tool call boundaries.
  messageChunks: string[]

  // Convenience alias for the last chunk.
  finalMessage: string
}

function normalizeAgentText(text: string): string {
  // Preserve leading whitespace (can be meaningful in markdown/code).
  return text.replace(/\r\n/g, "\n").trimEnd()
}

export class TurnRunner {
  private readonly runtime: TurnRuntime

  constructor(opt: { runtime: TurnRuntime }) {
    this.runtime = opt.runtime
  }

  async runTurn(opt: {
    contextId: string
    userText: string
  }): Promise<TurnRunResult> {
    const rawAssistantOutput = await this.runtime.runBlockingTurnRaw(opt)

    const dummyInterlocutor: Interlocutor = {
      name: this.runtime.interlocutorName,
      prompt: "",
      registry: {},
    }

    const msg = new AssistantMessage({
      content: rawAssistantOutput,
      interlocutor: dummyInterlocutor,
    })

    const { interactions } = msg.parseAssistantContent()

    const messageChunks = interactions
      .map((i) => normalizeAgentText(i.text))
      .filter((t) => t.trim().length > 0)

    const finalMessage =
      messageChunks.length > 0 ? messageChunks[messageChunks.length - 1] : ""

    return { rawAssistantOutput, messageChunks, finalMessage }
  }
}
