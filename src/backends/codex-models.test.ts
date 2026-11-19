import { describe, expect, test } from "bun:test"
import OpenAI from "openai"
import { CodexBackend } from "./codex"

function catalogBackend(body: unknown, status = 200) {
  const requests: Request[] = []
  const client = new OpenAI({
    apiKey: "test",
    baseURL: "https://example.test/backend-api/codex",
    maxRetries: 0,
    fetch: async (input, init) => {
      requests.push(new Request(input, init))
      return Response.json(body, { status })
    },
  })

  class CatalogBackend extends CodexBackend {
    override get client() {
      return client
    }
  }

  return { backend: new CatalogBackend(), requests }
}

describe("Codex model listing", () => {
  test("requests the versioned Codex catalog and reads slugs", async () => {
    const { backend, requests } = catalogBackend({
      models: [
        { slug: "gpt-6-astra", visibility: "list" },
        { slug: "future-model", visibility: "list" },
      ],
    })

    expect(await backend.listModels()).toEqual([
      "gpt-6-astra",
      "future-model",
    ])
    expect(requests).toHaveLength(1)
    const request = requests[0]
    const url = new URL(request.url)
    expect(request.method).toBe("GET")
    expect(url.pathname).toBe("/backend-api/codex/models")
    expect(url.searchParams.get("client_version")).toBe("0.169.0")
  })

  test("excludes hidden entries and invalid model records", async () => {
    const { backend } = catalogBackend({
      models: [
        { slug: "visible", visibility: "list" },
        { slug: "internal", visibility: "hide" },
        { slug: "unknown-visibility", visibility: "other" },
        { slug: "missing-visibility" },
        { visibility: "list" },
        { slug: 42, visibility: "list" },
        { slug: "", visibility: "list" },
        null,
        "invalid",
      ],
    })

    expect(await backend.listModels()).toEqual(["visible"])
  })

  test("handles an empty catalog", async () => {
    const { backend } = catalogBackend({ models: [] })
    expect(await backend.listModels()).toEqual([])
  })

  test.each([
    null,
    {},
    { models: null },
    { models: {} },
    { data: [{ id: "not-a-codex-catalog" }] },
  ])("handles an unexpected catalog shape: %j", async (body) => {
    const { backend } = catalogBackend(body)
    expect(await backend.listModels()).toEqual([])
  })

  test("keeps discovery failures non-fatal", async () => {
    const { backend, requests } = catalogBackend({
      error: { message: "Access denied" },
    }, 403)

    expect(await backend.listModels()).toEqual([])
    expect(requests).toHaveLength(1)
  })
})
