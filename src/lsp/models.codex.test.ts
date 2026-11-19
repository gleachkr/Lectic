import { expect, spyOn, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { CompletionTriggerKind } from "vscode-languageserver/node"
import { CodexBackend } from "../backends/codex"
import { computeCompletions } from "./completions"
import { initModelRegistry, onModelRegistryUpdate } from "./models"
import { withTemporaryLecticConfig } from "./utils/testHelpers"

function mockFetch(
  impl: (...args: Parameters<typeof fetch>) => Promise<Response>,
) {
  return spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(impl, { preconnect: () => {} }),
  )
}

async function withSavedCodexToken(
  expiresAt: number,
  run: () => Promise<void>,
) {
  const previousState = process.env["LECTIC_STATE"]
  const dir = await mkdtemp(join(tmpdir(), "lectic-lsp-codex-"))
  try {
    process.env["LECTIC_STATE"] = dir
    await writeFile(join(dir, "codex_auth.json"), JSON.stringify({
      access_token: "catalog-test-token",
      refresh_token: "catalog-test-refresh-token",
      expires_at: expiresAt,
    }))
    await run()
  } finally {
    if (previousState === undefined) delete process.env["LECTIC_STATE"]
    else process.env["LECTIC_STATE"] = previousState
    await rm(dir, { recursive: true, force: true })
  }
}

test("LSP completes visible models from the saved Codex account", async () => {
  await withSavedCodexToken(Date.now() + 120_000, async () => {
    const codexRequests: Request[] = []
    const fetchMock = mockFetch(async (input, init) => {
      const request = new Request(input, init)
      const url = new URL(request.url)
      if (url.origin !== "https://chatgpt.com") {
        // Keep any other configured providers offline as well.
        return Response.json({ data: [], models: [], has_more: false })
      }
      codexRequests.push(request)
      return Response.json({
        models: [
          { slug: "gpt-example", visibility: "list" },
          { slug: "other-example", visibility: "list" },
          { slug: "gpt-hidden", visibility: "hide" },
        ],
      })
    })
    let unsubscribe = () => {}
    try {
      await new Promise<void>(resolve => {
        unsubscribe = onModelRegistryUpdate(resolve)
        initModelRegistry()
      })
      expect(codexRequests).toHaveLength(1)
      expect(new URL(codexRequests[0].url).pathname).toBe(
        "/backend-api/codex/models",
      )
      expect(codexRequests[0].headers.get("authorization")).toBe(
        "Bearer catalog-test-token",
      )

      await withTemporaryLecticConfig(async () => {
        const header = "---\ninterlocutor:\n  name: A\n  provider: codex\n"
        const complete = (line: string) => computeCompletions(
          "file:///doc.lec",
          `${header}${line}\n---\n`,
          { line: 4, character: line.length },
          undefined,
          undefined,
          line.endsWith(":")
            ? { triggerKind: CompletionTriggerKind.TriggerCharacter,
                triggerCharacter: ":" }
            : { triggerKind: CompletionTriggerKind.Invoked },
        )

        const atColon = await complete("  model:")
        expect(atColon?.map(item => item.label)).toEqual([
          "gpt-example", "other-example",
        ])
        expect(atColon?.[0].textEdit).toEqual({
          range: {
            start: { line: 4, character: 8 },
            end: { line: 4, character: 8 },
          },
          newText: " gpt-example",
        })

        const prefixed = await complete("  model: gp")
        expect(prefixed?.map(item => item.label)).toEqual(["gpt-example"])
        expect(prefixed?.[0].textEdit).toEqual({
          range: {
            start: { line: 4, character: 9 },
            end: { line: 4, character: 11 },
          },
          newText: "gpt-example",
        })
      })
    } finally {
      unsubscribe()
      fetchMock.mockRestore()
    }
  })
})

test("background Codex discovery skips login on refresh failure", async () => {
  await withSavedCodexToken(0, async () => {
    const fetchMock = mockFetch(async () => new Response(null, { status: 401 }))
    const serveMock = spyOn(Bun, "serve").mockImplementation(() => {
      throw new Error("Background discovery must not start OAuth login")
    })
    try {
      const backend = new CodexBackend(undefined, { interactive: false })
      expect(await backend.listModels()).toEqual([])
      expect(fetchMock).toHaveBeenCalledTimes(1)
      expect(serveMock).not.toHaveBeenCalled()
    } finally {
      fetchMock.mockRestore()
      serveMock.mockRestore()
    }
  })
})
