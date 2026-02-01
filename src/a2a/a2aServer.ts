import type { AgentCard, JSONRPCResponse } from "@a2a-js/sdk"
import { ServerCallContext, type A2ARequestHandler }
  from "@a2a-js/sdk/server"
import type { JsonRpcTransportHandler } from "@a2a-js/sdk/server"

import type { TurnTaskEvent, TurnTaskSnapshot } from "../agents/turnTasks"
import { isAsyncIterable } from "../types/guards"

const SSE_HEADERS: Record<string, string> = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache",
  Connection: "keep-alive",
  "X-Accel-Buffering": "no",
}

type RouteRequest = Request & { params: Record<string, string> }

type MonitorAgentsResponse = {
  agents: Array<{
    agentId: string
    name: string
    description: string
    cardUrl: string
    monitoring: boolean
  }>
}

type MonitorTasksAllResponse = {
  agentId?: string
  contextId?: string
  agents: string[]
  contexts: string[]
  tasks: Array<TurnTaskSnapshot & { agentId: string }>
}

type MonitorableHandler = A2ARequestHandler & {
  listContextIds(): string[]
  listTaskIds(contextId: string): string[]
  listTaskSnapshots(opt?: { contextId?: string }): TurnTaskSnapshot[]
  getTaskSnapshot(taskId: string): TurnTaskSnapshot | undefined
  onTaskEvent(listener: (ev: TurnTaskEvent) => void): () => void
}

function isMonitorableHandler(
  handler: A2ARequestHandler
): handler is MonitorableHandler {
  const h = handler as Partial<MonitorableHandler>

  return (
    typeof h.listContextIds === "function" &&
    typeof h.listTaskIds === "function" &&
    typeof h.listTaskSnapshots === "function" &&
    typeof h.getTaskSnapshot === "function" &&
    typeof h.onTaskEvent === "function"
  )
}

export type A2AServerAgent = {
  agentId: string
  handler: A2ARequestHandler
  card: AgentCard
  transport: JsonRpcTransportHandler
}

export type StartA2AServerOptions = {
  host: string
  port: number
  agents: Map<string, A2AServerAgent>
  token?: string

  // Bun defaults to a 10s idle timeout, which is too aggressive for
  // streaming A2A responses (SSE) and for slower model providers.
  //
  // If unset, we disable the idle timeout for the entire server.
  idleTimeoutSeconds?: number
}

function isAuthorized(req: Request, token: string): boolean {
  const auth = req.headers.get("authorization")
  return auth === `Bearer ${token}`
}

function methodNotAllowed(): Response {
  return new Response("method not allowed", { status: 405 })
}

function notFound(): Response {
  return new Response("not found", { status: 404 })
}

function unauthorized(): Response {
  return new Response("unauthorized", {
    status: 401,
    headers: { "WWW-Authenticate": "Bearer" },
  })
}

function enforceAuth(req: Request, token?: string): Response | null {
  if (!token) return null
  if (isAuthorized(req, token)) return null
  return unauthorized()
}

function sendSse(
  controller: ReadableStreamDefaultController<Uint8Array>,
  enc: TextEncoder,
  payload: unknown
): void {
  controller.enqueue(enc.encode(`data: ${JSON.stringify(payload)}\n\n`))
}

export function startA2AServer(opt: StartA2AServerOptions): Bun.Server<unknown> {
  const idleTimeout = opt.idleTimeoutSeconds ?? 0

  const getAgent = (agentId: string): A2AServerAgent | null => {
    return opt.agents.get(agentId) ?? null
  }

  const getMonitorable = (agent: A2AServerAgent): MonitorableHandler | null => {
    return isMonitorableHandler(agent.handler) ? agent.handler : null
  }

  const handleAgentCard = (req: RouteRequest): Response => {
    const agentId = req.params["agentId"]
    const agent = agentId ? getAgent(agentId) : null
    if (!agent) return notFound()

    if (req.method !== "GET") return methodNotAllowed()

    return Response.json(agent.card)
  }

  const handleJsonRpc = async (req: RouteRequest): Promise<Response> => {
    const agentId = req.params["agentId"]
    const agent = agentId ? getAgent(agentId) : null
    if (!agent) return notFound()

    if (req.method !== "POST") return methodNotAllowed()

    const authRes = enforceAuth(req, opt.token)
    if (authRes) return authRes

    const bodyText = await req.text()
    const ctx = new ServerCallContext(undefined, undefined)

    const res = await agent.transport.handle(bodyText, ctx)

    if (isAsyncIterable<JSONRPCResponse>(res)) {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          const enc = new TextEncoder()
          void (async () => {
            for await (const event of res) {
              const payload = `data: ${JSON.stringify(event)}\n\n`
              controller.enqueue(enc.encode(payload))
            }
            controller.close()
          })().catch((e) => controller.error(e))
        },
      })

      return new Response(stream, { headers: SSE_HEADERS })
    }

    return Response.json(res)
  }

  const handleMonitorAgents = (req: Request): Response => {
    if (req.method !== "GET") return methodNotAllowed()

    const authRes = enforceAuth(req, opt.token)
    if (authRes) return authRes

    const origin = new URL(req.url).origin

    const agents = [...opt.agents.values()].map((a) => {
      const cardUrl =
        `${origin}/agents/${a.agentId}/.well-known/agent-card.json`

      return {
        agentId: a.agentId,
        name: a.card.name,
        description: a.card.description,
        cardUrl,
        monitoring: isMonitorableHandler(a.handler),
      }
    })

    const body: MonitorAgentsResponse = { agents }
    return Response.json(body)
  }

  const handleMonitorAgentTasks = (req: RouteRequest): Response => {
    const agentId = req.params["agentId"]
    const agent = agentId ? getAgent(agentId) : null
    if (!agent) return notFound()

    if (req.method !== "GET") return methodNotAllowed()

    const authRes = enforceAuth(req, opt.token)
    if (authRes) return authRes

    const handler = getMonitorable(agent)
    if (!handler) return notFound()

    const url = new URL(req.url)
    const contextId = url.searchParams.get("contextId") ?? undefined

    const contexts = handler.listContextIds()
    const tasks = handler.listTaskSnapshots({ contextId })

    return Response.json({ agentId, contextId, contexts, tasks })
  }

  const handleMonitorAgentTask = (req: RouteRequest): Response => {
    const agentId = req.params["agentId"]
    const taskId = req.params["taskId"]

    const agent = agentId ? getAgent(agentId) : null
    if (!agent || !taskId) return notFound()

    if (req.method !== "GET") return methodNotAllowed()

    const authRes = enforceAuth(req, opt.token)
    if (authRes) return authRes

    const handler = getMonitorable(agent)
    if (!handler) return notFound()

    const snap = handler.getTaskSnapshot(taskId)
    if (!snap) return notFound()

    return Response.json({ agentId, snapshot: snap })
  }

  const handleMonitorAgentEvents = (req: RouteRequest): Response => {
    const agentId = req.params["agentId"]
    const agent = agentId ? getAgent(agentId) : null
    if (!agent) return notFound()

    if (req.method !== "GET") return methodNotAllowed()

    const authRes = enforceAuth(req, opt.token)
    if (authRes) return authRes

    const handler = getMonitorable(agent)
    if (!handler) return notFound()

    const url = new URL(req.url)
    const contextId = url.searchParams.get("contextId") ?? undefined

    let unsubscribe: (() => void) | undefined

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const enc = new TextEncoder()

        sendSse(controller, enc, {
          kind: "hello",
          agents: [agentId],
          agentId,
          contextId,
        })

        for (const snap of handler.listTaskSnapshots({ contextId })) {
          sendSse(controller, enc, {
            kind: "snapshot",
            agentId,
            snapshot: snap,
          })
        }

        unsubscribe = handler.onTaskEvent((ev: TurnTaskEvent) => {
          if (contextId && ev.snapshot.contextId !== contextId) {
            return
          }

          sendSse(controller, enc, {
            kind: "event",
            agentId,
            event: ev,
          })
        })

        req.signal.addEventListener(
          "abort",
          () => {
            unsubscribe?.()
            unsubscribe = undefined
            controller.close()
          },
          { once: true },
        )
      },

      cancel() {
        unsubscribe?.()
        unsubscribe = undefined
      },
    })

    return new Response(stream, { headers: SSE_HEADERS })
  }

  const handleMonitorTasksAll = (req: Request): Response => {
    if (req.method !== "GET") return methodNotAllowed()

    const authRes = enforceAuth(req, opt.token)
    if (authRes) return authRes

    const url = new URL(req.url)
    const agentId = url.searchParams.get("agentId") ?? undefined
    const contextId = url.searchParams.get("contextId") ?? undefined

    const agentIds = agentId ? [agentId] : [...opt.agents.keys()]

    if (agentId && !opt.agents.has(agentId)) {
      return notFound()
    }

    const contexts = new Set<string>()
    const tasks: MonitorTasksAllResponse["tasks"] = []

    for (const id of agentIds) {
      const agent = opt.agents.get(id)
      if (!agent) continue

      const handler = getMonitorable(agent)
      if (!handler) continue

      for (const cid of handler.listContextIds()) {
        contexts.add(cid)
      }

      for (const snap of handler.listTaskSnapshots({ contextId })) {
        tasks.push({ agentId: id, ...snap })
      }
    }

    const body: MonitorTasksAllResponse = {
      agentId,
      contextId,
      agents: agentIds,
      contexts: [...contexts],
      tasks,
    }

    return Response.json(body)
  }

  const handleMonitorTaskAny = (req: RouteRequest): Response => {
    const taskId = req.params["taskId"]
    if (!taskId) return notFound()

    if (req.method !== "GET") return methodNotAllowed()

    const authRes = enforceAuth(req, opt.token)
    if (authRes) return authRes

    for (const agent of opt.agents.values()) {
      const handler = getMonitorable(agent)
      if (!handler) continue

      const snap = handler.getTaskSnapshot(taskId)
      if (!snap) continue

      return Response.json({ agentId: agent.agentId, snapshot: snap })
    }

    return notFound()
  }

  const handleMonitorEventsAll = (req: Request): Response => {
    if (req.method !== "GET") return methodNotAllowed()

    const authRes = enforceAuth(req, opt.token)
    if (authRes) return authRes

    const url = new URL(req.url)
    const agentId = url.searchParams.get("agentId") ?? undefined
    const contextId = url.searchParams.get("contextId") ?? undefined

    const agentIds = agentId ? [agentId] : [...opt.agents.keys()]

    if (agentId && !opt.agents.has(agentId)) {
      return notFound()
    }

    const monitorables: Array<{ id: string; h: MonitorableHandler }> = []

    for (const id of agentIds) {
      const agent = opt.agents.get(id)
      if (!agent) continue

      const h = getMonitorable(agent)
      if (!h) continue

      monitorables.push({ id, h })
    }

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const enc = new TextEncoder()

        sendSse(controller, enc, {
          kind: "hello",
          agents: monitorables.map((m) => m.id),
          agentId,
          contextId,
        })

        for (const m of monitorables) {
          for (const snap of m.h.listTaskSnapshots({ contextId })) {
            sendSse(controller, enc, {
              kind: "snapshot",
              agentId: m.id,
              snapshot: snap,
            })
          }
        }

        const unsubs = monitorables.map((m) => {
          return m.h.onTaskEvent((ev: TurnTaskEvent) => {
            if (contextId && ev.snapshot.contextId !== contextId) {
              return
            }

            sendSse(controller, enc, {
              kind: "event",
              agentId: m.id,
              event: ev,
            })
          })
        })

        req.signal.addEventListener(
          "abort",
          () => {
            for (const u of unsubs) u()
            controller.close()
          },
          { once: true },
        )
      },
    })

    return new Response(stream, { headers: SSE_HEADERS })
  }

  // Note: Bun's `routes` does not pass the `server` object to handlers,
  // so we rely on a server-wide idleTimeout=0 instead of per-request
  // `server.timeout(req, 0)`.
  return Bun.serve({
    hostname: opt.host,
    port: opt.port,
    idleTimeout,

    routes: {
      "/agents/:agentId/.well-known/agent-card.json": {
        GET: handleAgentCard,
      },

      "/agents/:agentId/a2a/jsonrpc": {
        POST: handleJsonRpc,
      },

      // New monitoring endpoints.
      "/monitor/agents": {
        GET: handleMonitorAgents,
      },

      "/monitor/tasks": {
        GET: handleMonitorTasksAll,
      },

      "/monitor/tasks/:taskId": {
        GET: handleMonitorTaskAny,
      },

      "/monitor/events": {
        GET: handleMonitorEventsAll,
      },

      "/monitor/agents/:agentId/tasks": {
        GET: handleMonitorAgentTasks,
      },

      "/monitor/agents/:agentId/tasks/:taskId": {
        GET: handleMonitorAgentTask,
      },

      "/monitor/agents/:agentId/events": {
        GET: handleMonitorAgentEvents,
      },
    },

    fetch() {
      return notFound()
    },
  })
}
