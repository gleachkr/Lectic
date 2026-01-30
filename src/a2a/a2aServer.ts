import type { AgentCard, JSONRPCResponse } from "@a2a-js/sdk"
import { ServerCallContext, type A2ARequestHandler }
  from "@a2a-js/sdk/server"
import type { JsonRpcTransportHandler } from "@a2a-js/sdk/server"

const SSE_HEADERS: Record<string, string> = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache",
  Connection: "keep-alive",
  "X-Accel-Buffering": "no",
}

function isAsyncIterable<T>(v: unknown): v is AsyncIterable<T> {
  return (
    typeof v === "object" &&
    v !== null &&
    Symbol.asyncIterator in v
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
  // If unset, we keep Bun's default for non-A2A endpoints, but we still
  // disable the timeout per-request for /a2a/jsonrpc.
  idleTimeoutSeconds?: number
}

export type BunServer = ReturnType<typeof Bun.serve>

function isAuthorized(req: Request, token: string): boolean {
  const auth = req.headers.get("authorization")
  return auth === `Bearer ${token}`
}

export function startA2AServer(opt: StartA2AServerOptions): BunServer {
  return Bun.serve({
    hostname: opt.host,
    port: opt.port,
    idleTimeout: opt.idleTimeoutSeconds,

    async fetch(req, server) {
      const url = new URL(req.url)
      const path = url.pathname

      const cardMatch =
        /^\/agents\/([^/]+)\/\.well-known\/agent-card\.json$/.exec(path)
      if (cardMatch) {
        const agentId = cardMatch[1]
        const agent = opt.agents.get(agentId)
        if (!agent) return new Response("not found", { status: 404 })

        if (req.method !== "GET") {
          return new Response("method not allowed", { status: 405 })
        }

        return Response.json(agent.card)
      }

      const rpcMatch = /^\/agents\/([^/]+)\/a2a\/jsonrpc$/.exec(path)
      if (rpcMatch) {
        // A2A can legitimately keep connections open for a long time.
        // Disable Bun's idle timeout for these requests to avoid spurious
        // disconnects while the agent is thinking.
        server.timeout(req, 0)
        const agentId = rpcMatch[1]
        const agent = opt.agents.get(agentId)
        if (!agent) return new Response("not found", { status: 404 })

        if (req.method !== "POST") {
          return new Response("method not allowed", { status: 405 })
        }

        if (opt.token && !isAuthorized(req, opt.token)) {
          return new Response("unauthorized", {
            status: 401,
            headers: { "WWW-Authenticate": "Bearer" },
          })
        }

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

      return new Response("not found", { status: 404 })
    },
  })
}
