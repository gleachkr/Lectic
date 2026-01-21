import { createHash, randomBytes } from "crypto"
import open from "open"
import { join } from "path"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs"
import { lecticStateDir } from "../utils/xdg"
import { Logger } from "../logging/logger"
import { isObjectRecord } from "../types/guards"

// OAuth details for the official Codex / ChatGPT subscription flow.
//
// This matches OpenAI's Codex CLI OAuth client (see the opencode
// opencode-openai-codex-auth plugin).
const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann"
const AUTH_DOMAIN = "auth.openai.com"
const AUTHORIZE_PATH = "/oauth/authorize"
const TOKEN_PATH = "/oauth/token"
const REDIRECT_URI = "http://localhost:1455/auth/callback"
const SCOPE = "openid profile email offline_access"

interface TokenSet {
  access_token: string
  refresh_token: string
  expires_in: number
  expires_at: number
}

type TokenResponse = {
  access_token: string
  refresh_token?: string
  expires_in: number
}

function parseTokenResponse(data: unknown): TokenResponse {
  if (!isObjectRecord(data)) {
    throw new Error("Token endpoint returned a non-object payload")
  }

  if (typeof data["access_token"] !== "string") {
    throw new Error("Token endpoint did not return access_token")
  }

  if (typeof data["expires_in"] !== "number") {
    throw new Error("Token endpoint did not return expires_in")
  }

  if (
    data["refresh_token"] !== undefined &&
    typeof data["refresh_token"] !== "string"
  ) {
    throw new Error("Token endpoint returned a non-string refresh_token")
  }

  return {
    access_token: data["access_token"],
    expires_in: data["expires_in"],
    refresh_token: data["refresh_token"],
  }
}

function base64URLEncode(buffer: Buffer): string {
  return buffer.toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "")
}

function sha256(buffer: Buffer): Buffer {
  return createHash("sha256").update(buffer).digest()
}

export class ChatGPTAuth {
  private tokenPath: string;

  constructor() {
    const stateDir = lecticStateDir()
    if (!existsSync(stateDir)) {
      mkdirSync(stateDir, { recursive: true })
    }
    this.tokenPath = join(stateDir, "chatgpt_auth.json")
  }

  isAuthenticated(): boolean {
    return existsSync(this.tokenPath)
  }

  async getAccessToken(): Promise<string> {
    let tokens = this.loadTokens()

    if (!tokens) {
      console.error("No ChatGPT tokens found. Initiating login...")
      tokens = await this.login()
      this.saveTokens(tokens)
    } else if (Date.now() >= tokens.expires_at - 60000) {
      // Buffer of 60s
      Logger.debug("auth", "ChatGPT token expired. Refreshing...")
      try {
        tokens = await this.refresh(tokens)
        this.saveTokens(tokens)
      } catch (error) {
        Logger.debug("auth", [
          "Failed to refresh token, re-initiating login.",
          error,
        ])
        console.error("Session expired. Re-initiating login...")
        tokens = await this.login()
        this.saveTokens(tokens)
      }
    }

    return tokens.access_token
  }

  private loadTokens(): TokenSet | null {
    if (!existsSync(this.tokenPath)) return null
    try {
      return JSON.parse(readFileSync(this.tokenPath, "utf-8"))
    } catch {
      return null
    }
  }

  private saveTokens(tokens: TokenSet) {
    writeFileSync(this.tokenPath, JSON.stringify(tokens, null, 2))
  }

  private async login(): Promise<TokenSet> {
    const verifier = base64URLEncode(randomBytes(32))
    const challenge = base64URLEncode(sha256(Buffer.from(verifier)))
    const state = base64URLEncode(randomBytes(16))

    const params = new URLSearchParams({
      response_type: "code",
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      scope: SCOPE,
      code_challenge: challenge,
      code_challenge_method: "S256",
      state,
      // These extra flags match the official Codex CLI.
      id_token_add_organizations: "true",
      codex_cli_simplified_flow: "true",
      originator: "codex_cli_rs",
    })

    const authUrl =
      `https://${AUTH_DOMAIN}${AUTHORIZE_PATH}?${params.toString()}`

    // Start local server to capture callback.
    const codePromise = new Promise<string>((resolve, reject) => {
      const server = Bun.serve({
        port: 1455,
        fetch(req) {
          const url = new URL(req.url)
          if (url.pathname === "/auth/callback") {
            const code = url.searchParams.get("code")
            const receivedState = url.searchParams.get("state")

            if (receivedState !== state) {
              return new Response("Invalid state parameter", { status: 400 })
            }

            if (code) {
              resolve(code)
              setTimeout(() => { void server.stop() }, 100)
              return new Response(
                "Authentication successful! You can close this window and " +
                  "return to Lectic."
              )
            }

            reject(new Error("No code received"))
            setTimeout(() => { void server.stop() }, 100)
            return new Response("Authentication failed", { status: 400 })
          }
          return new Response("Not found", { status: 404 })
        },
      })
      Logger.debug("auth", `Listening on ${REDIRECT_URI}`)
    })

    console.error("Opening browser for authentication...")
    console.error(`URL: ${authUrl}`)
    try {
      await open(authUrl)
    } catch (_e) {
      console.error(
        "Failed to open browser automatically. Please visit the URL above."
      )
    }

    const code = await codePromise
    Logger.debug("auth", "Authorization code received. Exchanging for tokens...")

    return this.exchangeCode(code, verifier)
  }

  private async exchangeCode(code: string, verifier: string): Promise<TokenSet> {
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      client_id: CLIENT_ID,
      code,
      redirect_uri: REDIRECT_URI,
      code_verifier: verifier,
    })

    const res = await fetch(`https://${AUTH_DOMAIN}${TOKEN_PATH}`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    })

    if (!res.ok) {
      const txt = await res.text()
      throw new Error(`Token exchange failed: ${res.status} ${txt}`)
    }

    const data = parseTokenResponse(await res.json())

    if (!data.refresh_token) {
      throw new Error("Token exchange did not return refresh_token")
    }

    return {
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      expires_in: data.expires_in,
      expires_at: Date.now() + data.expires_in * 1000,
    }
  }

  private async refresh(tokens: TokenSet): Promise<TokenSet> {
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      client_id: CLIENT_ID,
      refresh_token: tokens.refresh_token,
    })

    const res = await fetch(`https://${AUTH_DOMAIN}${TOKEN_PATH}`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    })

    if (!res.ok) {
      const txt = await res.text()
      throw new Error(`Token refresh failed: ${res.status} ${txt}`)
    }

    const data = parseTokenResponse(await res.json())

    return {
      access_token: data.access_token,
      refresh_token: data.refresh_token ?? tokens.refresh_token,
      expires_in: data.expires_in,
      expires_at: Date.now() + data.expires_in * 1000,
    }
  }
}

