// Replay the original wire-level regression cases through the new boundary.
// New neutral cases use Coordinator/startServer directly, without this shim.
import {
  Coordinator as NeutralCoordinator, type Backend, type CoordinatorOptions,
} from "../coordinator"
import { openAIObservation, openAIProvider } from "../openai"
import type { LiveEvent } from "../protocol"
import type { WorkObservation } from "../provider"
import type { Connect } from "../session"
import { startServer as start, type ServerOptions as NeutralOptions }
  from "../server"

export class Coordinator extends NeutralCoordinator {
  constructor(
    sessionId: string, backend: Backend,
    deliver: (id: string, content: string) => Promise<void>,
    options: CoordinatorOptions | number = {},
  ) {
    super({
      provider: "openai", sessionId, sessionIdSource: "provider",
    }, backend, async completion => {
      if (!("summary" in completion)) {
        return { transmission: "not_sent", acknowledgment: "unavailable" }
      }
      await deliver(completion.requestId, completion.summary)
      return { transmission: "sent", acknowledgment: "acknowledged" }
    }, options)
    this.sessionId = sessionId
  }
  private sessionId: string
  override receive(event: LiveEvent | WorkObservation) {
    const observation = "owner" in event
      ? event : openAIObservation(this.sessionId, event)
    if (observation?.type === "transcript"
      || observation?.type === "request") super.receive(observation)
  }
}

export type ServerOptions = Omit<NeutralOptions, "connect">
  & { connect: Connect }

export function startServer(options: ServerOptions) {
  return start({ ...options, connect: openAIProvider(options.connect) })
}
