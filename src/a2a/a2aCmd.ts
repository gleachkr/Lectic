import { resolve } from "node:path"

import type { AgentCard } from "@a2a-js/sdk"
import { JsonRpcTransportHandler } from "@a2a-js/sdk/server"

import { version } from "../../package.json"

import { getIncludes } from "../utils/cli"
import { lecticStateDir } from "../utils/xdg"
import {
  LecticHeader,
  type LecticHeaderSpec,
  validateLecticHeaderSpec,
} from "../types/lectic"
import type { Interlocutor } from "../types/interlocutor"

import { A2A_CONTEXT_ID_RE } from "./contextId"
import { A2AAgentHandler } from "./a2aAgentHandler"
import {
  startA2AServer,
  type A2AServerAgent,
} from "./a2aServer"
import {
  computeWorkspaceKey,
  PersistedAgentRuntime,
} from "../agents/persistedRuntime"

function slugifyAgentId(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "")

  return slug || "agent"
}

function buildAgentId(interlocutor: Interlocutor): string {
  const id = interlocutor.a2a?.id ?? slugifyAgentId(interlocutor.name)

  if (!A2A_CONTEXT_ID_RE.test(id)) {
    throw new Error(
      `Invalid agent id ${JSON.stringify(id)} for ${interlocutor.name}. ` +
        `Expected pattern ${A2A_CONTEXT_ID_RE}.`
    )
  }

  return id
}

function buildAgentCard(opt: {
  host: string
  port: number
  agentId: string
  interlocutor: Interlocutor
  tokenRequired: boolean
}): AgentCard {
  const url = `http://${opt.host}:${opt.port}/agents/${opt.agentId}/a2a/jsonrpc`

  const description =
    opt.interlocutor.a2a?.description ??
    `Lectic agent exposed from interlocutor ${opt.interlocutor.name}.`

  const card: AgentCard = {
    name: opt.interlocutor.name,
    description,
    protocolVersion: "0.3.0",
    version,
    preferredTransport: "JSONRPC",
    url,
    capabilities: {
      streaming: true,
      pushNotifications: false,
    },
    defaultInputModes: ["text"],
    defaultOutputModes: ["text"],
    skills: [
      {
        id: "chat",
        name: "Chat",
        description: "General chat.",
        tags: ["chat"],
      },
    ],
  }

  if (opt.tokenRequired) {
    card.securitySchemes = {
      lecticBearer: {
        type: "http",
        scheme: "bearer",
      },
    }

    card.security = [{ lecticBearer: [] }]
  }

  return card
}

export async function a2aCmd(opts: {
  root: string
  host: string
  port: number
  token?: string
  maxTasksPerContext?: number
}): Promise<void> {
  const root = resolve(opts.root)
  process.chdir(root)

  const workspaceKey = await computeWorkspaceKey(root)

  const includes = await getIncludes()
  const specRaw = LecticHeader.mergeInterlocutorSpecs(includes)

  if (!validateLecticHeaderSpec(specRaw)) {
    throw new Error("Invalid Lectic config.")
  }

  const baseSpec: LecticHeaderSpec = specRaw
  const baseHeader = new LecticHeader(baseSpec)

  const agentInterlocutors = baseHeader.interlocutors.filter((i) => i.a2a)

  if (agentInterlocutors.length === 0) {
    throw new Error(
      "No A2A agents configured. Add interlocutor.a2a to lectic.yaml."
    )
  }

  const agents = new Map<string, A2AServerAgent>()

  for (const inter of agentInterlocutors) {
    const agentId = buildAgentId(inter)

    const initHeader = new LecticHeader(baseSpec)
    initHeader.setSpeaker(inter.name)
    await initHeader.initialize()

    const card = buildAgentCard({
      host: opts.host,
      port: opts.port,
      agentId,
      interlocutor: inter,
      tokenRequired: typeof opts.token === "string" && opts.token.length > 0,
    })

    const runtime = new PersistedAgentRuntime({
      agentId,
      interlocutorName: inter.name,
      baseSpec,
      transcriptRoot: `${lecticStateDir()}/a2a/`,
      workspaceKey,
    })

    const handler = new A2AAgentHandler({
      runtime,
      card,
      maxTasksPerContext: opts.maxTasksPerContext,
    })
    const transport = new JsonRpcTransportHandler(handler)

    agents.set(agentId, { agentId, handler, card, transport })
  }

  const server = startA2AServer({
    host: opts.host,
    port: opts.port,
    agents,
    token: opts.token,
  })
  const actualPort = server.port

  if (actualPort !== opts.port) {
    for (const agent of agents.values()) {
      agent.card.url =
        `http://${opts.host}:${actualPort}/agents/${agent.agentId}/a2a/jsonrpc`
    }
  }

  console.log(
    `Lectic A2A server running on http://${opts.host}:${actualPort} ` +
      `(${agents.size} agent(s))`
  )

  if (opts.host !== "127.0.0.1" && opts.host !== "localhost") {
    console.warn(
      "Warning: you are binding the A2A server to a non-loopback address. " +
        "Consider using --token and/or a reverse proxy with TLS."
    )
  }

  if (opts.token) {
    console.log("Auth: bearer token required for /a2a/jsonrpc")
  }

  for (const agentId of agents.keys()) {
    console.log(
      `  - http://${opts.host}:${actualPort}/agents/${agentId}/.well-known/` +
        `agent-card.json`
    )
  }
}
