import OpenAI from "openai"
import { OpenAIResponsesBackend } from "./openai-responses"
import { CodexAuth } from "../auth/codex"
import { LLMProvider } from "../types/provider"
import { isObjectRecord } from "../types/guards"
import { createCodexWebSocketFetch, type CodexWebSocketFetch } from "./codex-websocket"

const CODEX_CODEX_BASE_URL = "https://chatgpt.com/backend-api/codex"
const OPENAI_BETA = "OpenAI-Beta"
const OPENAI_BETA_RESPONSES = "responses=experimental"
const CODEX_ACCOUNT_ID_HEADER = "chatgpt-account-id"
const ORIGINATOR_HEADER = "originator"
const ORIGINATOR_CODEX = "codex_cli_rs"
// The catalog is version-gated. Pin the Codex client version whose response
// format we support, rather than sending Lectic's unrelated package version.
const CODEX_CLIENT_VERSION = "0.169.0"

function base64UrlDecode(input: string): string {
  const base64 = input.replace(/-/g, "+").replace(/_/g, "/")
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=")
  return Buffer.from(padded, "base64").toString("utf-8")
}

function getCodexAccountId(accessToken: string): string | null {
  const parts = accessToken.split(".")
  if (parts.length !== 3) return null

  try {
    const payloadRaw = base64UrlDecode(parts[1])
    const payload = JSON.parse(payloadRaw) as unknown
    if (!isObjectRecord(payload)) return null

    const authClaim = payload["https://api.openai.com/auth"]
    if (!isObjectRecord(authClaim)) return null

    const accountId = authClaim["chatgpt_account_id"]
    return typeof accountId === "string" ? accountId : null
  } catch {
    return null
  }
}

export class CodexBackend extends OpenAIResponsesBackend {
  account?: string
  private auth: CodexAuth
  private _client?: OpenAI
  private _webSocketFetch?: CodexWebSocketFetch

  constructor(
    account?: string,
    private readonly authOptions: { interactive?: boolean } = {},
  ) {
    super({
      apiKeyEnv: "CODEX_ACCESS_TOKEN",
      provider: LLMProvider.Codex,
      defaultModel: "gpt-5.4",
    })
    this.account = account
    this.auth = new CodexAuth(account)
    this.cache_retention = false
  }

  override async listModels(): Promise<string[]> {
    try {
      // Codex returns { models: [{ slug, visibility, ... }] }, not an
      // OpenAI models page. Use the same authenticated client as generation.
      const catalog = await this.client.get<unknown>("/models", {
        query: { client_version: CODEX_CLIENT_VERSION },
        maxRetries: this.authOptions.interactive === false ? 0 : undefined,
      })
      if (!isObjectRecord(catalog) || !Array.isArray(catalog["models"])) {
        return []
      }

      const models: string[] = []
      for (const model of catalog["models"]) {
        if (!isObjectRecord(model) || model["visibility"] !== "list") continue
        const slug = model["slug"]
        if (typeof slug === "string" && slug.length > 0) models.push(slug)
      }
      return models
    } catch (_e) {
      // Model discovery is best-effort, as with the other backends.
      return []
    }
  }

  get client() {
    if (this._client) return this._client

    this._webSocketFetch = createCodexWebSocketFetch()

    this._client = new OpenAI({
      // The SDK wants some apiKey value, but we override the Authorization
      // header at request time using a custom fetch.
      apiKey: "chatgpt",
      baseURL: CODEX_CODEX_BASE_URL,
      fetch: async (input, init) => {
        const token = await this.auth.getAccessToken(this.authOptions)
        const accountId = getCodexAccountId(token)

        const headers = new Headers(init?.headers)
        headers.set("Authorization", `Bearer ${token}`)
        headers.set(OPENAI_BETA, OPENAI_BETA_RESPONSES)
        headers.set(ORIGINATOR_HEADER, ORIGINATOR_CODEX)
        headers.set("accept", "text/event-stream")

        if (accountId) {
          headers.set(CODEX_ACCOUNT_ID_HEADER, accountId)
        }

        return this._webSocketFetch!(input, {
          ...init,
          headers,
        })
      },
    })

    return this._client
  }
}
