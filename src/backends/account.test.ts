import { describe, expect, it } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { CodexAuth } from "../auth/codex"
import { AnthropicBackend } from "./anthropic"
import { CodexBackend } from "./codex"
import { GeminiBackend } from "./gemini"
import { OpenAIResponsesBackend } from "./openai-responses"
import { getBackend } from "./util"
import { LLMProvider } from "../types/provider"

function withStateRoot<T>(callback: (stateRoot: string) => T): T {
  const stateRoot = mkdtempSync(join(tmpdir(), "lectic-codex-state-"))
  const previousState = process.env["LECTIC_STATE"]
  process.env["LECTIC_STATE"] = stateRoot

  try {
    return callback(stateRoot)
  } finally {
    rmSync(stateRoot, { recursive: true, force: true })
    if (previousState === undefined) {
      delete process.env["LECTIC_STATE"]
    } else {
      process.env["LECTIC_STATE"] = previousState
    }
  }
}

describe("interlocutor account handling", () => {
  it("passes explicit API keys through backend selection", () => {
    const openai = getBackend({
      name: "OpenAI",
      prompt: "p",
      provider: LLMProvider.OpenAIResponses,
      account: "openai-key",
    } as any)

    const anthropic = getBackend({
      name: "Anthropic",
      prompt: "p",
      provider: LLMProvider.Anthropic,
      account: "anthropic-key",
    } as any)

    const gemini = getBackend({
      name: "Gemini",
      prompt: "p",
      provider: LLMProvider.Gemini,
      account: "gemini-key",
    } as any)

    expect(openai).toBeInstanceOf(OpenAIResponsesBackend)
    expect((openai as OpenAIResponsesBackend).apiKeyValue).toBe("openai-key")

    expect(anthropic).toBeInstanceOf(AnthropicBackend)
    expect((anthropic as AnthropicBackend).apiKeyValue).toBe("anthropic-key")

    expect(gemini).toBeInstanceOf(GeminiBackend)
    expect((gemini as GeminiBackend).apiKeyValue).toBe("gemini-key")
  })

  it("uses named Codex credential files when account is set", () => {
    withStateRoot((stateRoot) => {
      const auth = new CodexAuth("work/team") as any
      const expected = join(
        stateRoot,
        "codex_auth",
        `${encodeURIComponent("work/team")}.json`,
      )

      expect(auth.tokenPath).toBe(expected)

      const backend = getBackend({
        name: "Codex",
        prompt: "p",
        provider: LLMProvider.Codex,
        account: "work/team",
      } as any)

      expect(backend).toBeInstanceOf(CodexBackend)
      expect((backend as CodexBackend).account).toBe("work/team")
    })
  })

  it("keeps the legacy default Codex token path when no account is set", () => {
    withStateRoot((stateRoot) => {
      const auth = new CodexAuth() as any
      expect(auth.tokenPath).toBe(join(stateRoot, "codex_auth.json"))
    })
  })
})
