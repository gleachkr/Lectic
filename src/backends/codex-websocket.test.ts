import { afterEach, describe, expect, test } from "bun:test"
import { createCodexWebSocketFetch } from "./codex-websocket"

const servers: Bun.Server<{ headers: Headers }>[] = []

afterEach(async () => {
  for (const server of servers.splice(0)) await server.stop(true)
})

function startResponsesServer(options: { preludeEvents?: unknown[] } = {}) {
  const websocketRequests: unknown[] = []
  const handshakeHeaders: Headers[] = []
  const httpRequests: string[] = []

  const server = Bun.serve<{ headers: Headers }>({
    port: 0,
    fetch(request, server) {
      const url = new URL(request.url)
      if (url.pathname !== "/responses") return new Response("not found", { status: 404 })
      if (request.headers.get("upgrade")?.toLowerCase() === "websocket") {
        handshakeHeaders.push(new Headers(request.headers))
        if (server.upgrade(request, { data: { headers: new Headers(request.headers) } })) {
          return undefined
        }
        return new Response("upgrade failed", { status: 500 })
      }
      return request.text().then((text) => {
        httpRequests.push(text)
        return new Response("http fallback", { status: 200 })
      })
    },
    websocket: {
      message(socket, message) {
        const text = typeof message === "string"
          ? message
          : new TextDecoder().decode(message)
        websocketRequests.push(JSON.parse(text))
        for (const event of options.preludeEvents ?? []) {
          socket.send(JSON.stringify(event))
        }
        socket.send(JSON.stringify({
          type: "response.created",
          response: { id: "resp_1", output: [] },
        }))
        socket.send(JSON.stringify({
          type: "response.output_text.delta",
          delta: "hi",
        }))
        socket.send(JSON.stringify({
          type: "response.completed",
          response: { id: "resp_1", output: [] },
        }))
      },
    },
  })
  servers.push(server)

  return {
    url: new URL("/responses", server.url).toString(),
    websocketRequests,
    handshakeHeaders,
    httpRequests,
  }
}

describe("codex websocket fetch", () => {
  test("streams Responses requests over WebSocket", async () => {
    const server = startResponsesServer()
    const wsFetch = createCodexWebSocketFetch()

    const response = await wsFetch(server.url, {
      method: "POST",
      headers: {
        Authorization: "Bearer test-token",
        "OpenAI-Beta": "responses=experimental",
      },
      body: JSON.stringify({
        model: "gpt-test",
        stream: true,
        prompt_cache_key: "project-cache-key",
        input: [],
      }),
    })

    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toContain("text/event-stream")
    expect(await response.text()).toContain("data: [DONE]")
    expect(server.httpRequests).toEqual([])

    expect(server.websocketRequests).toEqual([
      {
        type: "response.create",
        model: "gpt-test",
        stream: true,
        prompt_cache_key: "project-cache-key",
        input: [],
      },
    ])

    const handshake = server.handshakeHeaders[0]
    expect(handshake.get("authorization")).toBe("Bearer test-token")
    expect(handshake.get("openai-beta")).toBe("responses_websockets=2026-02-06")
    expect(handshake.get("session-id")).toBe("project-cache-key")
    expect(handshake.get("thread-id")).toBe("project-cache-key")

    wsFetch.close()
  })

  test("skips Codex side-channel events before response.created", async () => {
    const server = startResponsesServer({
      preludeEvents: [{
        type: "codex.rate_limits",
        plan_type: "plus",
      }],
    })
    const wsFetch = createCodexWebSocketFetch()

    const response = await wsFetch(server.url, {
      method: "POST",
      body: JSON.stringify({
        model: "gpt-test",
        stream: true,
        input: [],
      }),
    })

    const text = await response.text()
    expect(text).toContain("response.created")
    expect(text).not.toContain("codex.rate_limits")
    expect(text).toContain("data: [DONE]")

    wsFetch.close()
  })

  test("uses HTTP for non-streaming requests", async () => {
    const server = startResponsesServer()
    const wsFetch = createCodexWebSocketFetch()

    const response = await wsFetch(server.url, {
      method: "POST",
      body: JSON.stringify({
        model: "gpt-test",
        stream: false,
        input: [],
      }),
    })

    expect(await response.text()).toBe("http fallback")
    expect(server.websocketRequests).toEqual([])
    expect(server.httpRequests).toHaveLength(1)

    wsFetch.close()
  })
})
