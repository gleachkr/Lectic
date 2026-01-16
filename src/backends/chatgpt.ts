import OpenAI from "openai"
import { OpenAIResponsesBackend } from "./openai-responses"
import { ChatGPTAuth } from "../auth/chatgpt"
import { LLMProvider } from "../types/provider"
import { isObjectRecord } from "../types/guards"

const CHATGPT_CODEX_BASE_URL = "https://chatgpt.com/backend-api/codex"
const OPENAI_BETA = "OpenAI-Beta"
const OPENAI_BETA_RESPONSES = "responses=experimental"
const CHATGPT_ACCOUNT_ID_HEADER = "chatgpt-account-id"
const ORIGINATOR_HEADER = "originator"
const ORIGINATOR_CODEX = "codex_cli_rs"

function base64UrlDecode(input: string): string {
  const base64 = input.replace(/-/g, "+").replace(/_/g, "/")
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=")
  return Buffer.from(padded, "base64").toString("utf-8")
}

function getChatGPTAccountId(accessToken: string): string | null {
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

export class ChatGPTBackend extends OpenAIResponsesBackend {
  private auth: ChatGPTAuth
  private _client?: OpenAI

  constructor() {
    super({
      apiKey: "CHATGPT_ACCESS_TOKEN",
      provider: LLMProvider.ChatGPT,
      // This is a reasonable default for subscription auth. Users can still
      // override it in their lectic header.
      defaultModel: "gpt-5.1-codex",
    })
    this.auth = new ChatGPTAuth()
  }

  get client() {
    if (this._client) return this._client

    this._client = new OpenAI({
      // The SDK wants some apiKey value, but we override the Authorization
      // header at request time using a custom fetch.
      apiKey: "chatgpt",
      baseURL: CHATGPT_CODEX_BASE_URL,
      fetch: async (input, init) => {
        const token = await this.auth.getAccessToken()
        const accountId = getChatGPTAccountId(token)

        const headers = new Headers(init?.headers)
        headers.set("Authorization", `Bearer ${token}`)
        headers.set(OPENAI_BETA, OPENAI_BETA_RESPONSES)
        headers.set(ORIGINATOR_HEADER, ORIGINATOR_CODEX)
        headers.set("accept", "text/event-stream")

        if (accountId) {
          headers.set(CHATGPT_ACCOUNT_ID_HEADER, accountId)
        }

        return fetch(input, {
          ...init,
          headers,
        })
      },
    })

    return this._client
  }
}
