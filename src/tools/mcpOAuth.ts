import {
    chmodSync,
    existsSync,
    mkdirSync,
    readFileSync,
    renameSync,
    unlinkSync,
    writeFileSync,
} from "fs"
import { createHash, randomUUID } from "crypto"
import { join } from "path"
import {
    type OAuthClientMetadata,
    type OAuthClientProvider,
    type OAuthDiscoveryState,
    type StoredOAuthClientInformation,
    type StoredOAuthTokens,
} from "@modelcontextprotocol/client"
import open from "open"
import { lecticDataDir } from "../utils/xdg"

type CredentialScope =
    | "all"
    | "client"
    | "tokens"
    | "verifier"
    | "discovery"

type PersistedOAuthState = {
    clientInformation?: StoredOAuthClientInformation
    tokens?: StoredOAuthTokens
    codeVerifier?: string
    oauthState?: string
    discoveryState?: OAuthDiscoveryState
}

export class FilePersistedOAuthClientProvider
    implements OAuthClientProvider {
    private _clientInformation?: StoredOAuthClientInformation
    private _tokens?: StoredOAuthTokens
    private _codeVerifier?: string
    private _oauthState?: string
    private _discoveryState?: OAuthDiscoveryState
    private readonly storagePath: string
    private readonly _onRedirect: (url: URL) => void

    constructor(
        private readonly _redirectUrl: string | URL,
        private readonly _clientMetadata: OAuthClientMetadata,
        storageId: string,
        onRedirect?: (url: URL) => void,
        public readonly clientMetadataUrl?: string,
    ) {
        const dataDir = lecticDataDir()
        mkdirSync(dataDir, {
            recursive: true,
            mode: 0o700,
        })

        const storageHash = createHash("sha256")
            .update(storageId)
            .digest("hex")
        this.storagePath = join(
            dataDir,
            `mcp_oauth_${storageHash}.json`,
        )

        const legacySafeId = storageId.replace(
            /[^a-zA-Z0-9]/g,
            "_",
        )
        const legacyPath = join(
            dataDir,
            `mcp_oauth_${legacySafeId}.json`,
        )
        if (
            !existsSync(this.storagePath) &&
            existsSync(legacyPath)
        ) {
            chmodSync(legacyPath, 0o600)
            renameSync(legacyPath, this.storagePath)
        }

        this.loadState()

        this._onRedirect = onRedirect ?? ((url) => {
            console.log(
                "Opening browser for authorization: " +
                url.toString(),
            )
            void open(url.toString()).catch(() => {
                // A browser may be unavailable in headless environments.
            })
        })
    }

    private loadState(): void {
        if (!existsSync(this.storagePath)) return

        chmodSync(this.storagePath, 0o600)

        try {
            const data = JSON.parse(
                readFileSync(this.storagePath, "utf8"),
            ) as PersistedOAuthState

            this._clientInformation = data.clientInformation
            this._tokens = data.tokens
            this._codeVerifier = data.codeVerifier
            this._oauthState = data.oauthState
            this._discoveryState = data.discoveryState
        } catch (error) {
            console.warn(
                "Failed to load OAuth state from " +
                this.storagePath,
                error,
            )
        }
    }

    private saveState(): void {
        const data: PersistedOAuthState = {
            clientInformation: this._clientInformation,
            tokens: this._tokens,
            codeVerifier: this._codeVerifier,
            oauthState: this._oauthState,
            discoveryState: this._discoveryState,
        }
        const temporaryPath =
            `${this.storagePath}.${process.pid}.${randomUUID()}.tmp`

        try {
            writeFileSync(
                temporaryPath,
                JSON.stringify(data, null, 2),
                {
                    encoding: "utf8",
                    mode: 0o600,
                    flag: "wx",
                },
            )
            chmodSync(temporaryPath, 0o600)
            renameSync(temporaryPath, this.storagePath)
        } catch (error) {
            if (existsSync(temporaryPath)) {
                try {
                    unlinkSync(temporaryPath)
                } catch {
                    // Do not hide the persistence failure.
                }
            }
            throw error
        }
    }

    private updateState(update: () => void): void {
        const previous: PersistedOAuthState = {
            clientInformation: this._clientInformation,
            tokens: this._tokens,
            codeVerifier: this._codeVerifier,
            oauthState: this._oauthState,
            discoveryState: this._discoveryState,
        }

        update()

        try {
            this.saveState()
        } catch (error) {
            this._clientInformation = previous.clientInformation
            this._tokens = previous.tokens
            this._codeVerifier = previous.codeVerifier
            this._oauthState = previous.oauthState
            this._discoveryState = previous.discoveryState
            throw error
        }
    }

    get redirectUrl(): string | URL {
        return this._redirectUrl
    }

    get clientMetadata(): OAuthClientMetadata {
        return this._clientMetadata
    }

    state(): string {
        const state = randomUUID()
        this.updateState(() => {
            this._oauthState = state
        })
        return state
    }

    expectedState(): string {
        if (!this._oauthState) {
            throw new Error("No OAuth authorization is pending")
        }
        return this._oauthState
    }

    completeAuthorization(): void {
        this.updateState(() => {
            this._oauthState = undefined
            this._codeVerifier = undefined
        })
    }

    clientInformation():
        StoredOAuthClientInformation | undefined {
        return this._clientInformation
    }

    saveClientInformation(
        clientInformation: StoredOAuthClientInformation,
    ): void {
        this.updateState(() => {
            this._clientInformation = clientInformation
        })
    }

    tokens(): StoredOAuthTokens | undefined {
        return this._tokens
    }

    saveTokens(tokens: StoredOAuthTokens): void {
        this.updateState(() => {
            this._tokens = tokens
        })
    }

    redirectToAuthorization(authorizationUrl: URL): void {
        this._onRedirect(authorizationUrl)
    }

    saveCodeVerifier(codeVerifier: string): void {
        this.updateState(() => {
            this._codeVerifier = codeVerifier
        })
    }

    codeVerifier(): string {
        if (!this._codeVerifier) {
            throw new Error("No code verifier saved")
        }
        return this._codeVerifier
    }

    saveDiscoveryState(state: OAuthDiscoveryState): void {
        this.updateState(() => {
            this._discoveryState = state
        })
    }

    discoveryState(): OAuthDiscoveryState | undefined {
        return this._discoveryState
    }

    invalidateCredentials(scope: CredentialScope): void {
        this.updateState(() => {
            if (scope === "all" || scope === "client") {
                this._clientInformation = undefined
            }
            if (scope === "all" || scope === "tokens") {
                this._tokens = undefined
            }
            if (scope === "all" || scope === "verifier") {
                this._codeVerifier = undefined
                this._oauthState = undefined
            }
            if (scope === "all" || scope === "discovery") {
                this._discoveryState = undefined
            }
        })
    }
}

export function validateOAuthCallbackState(
    params: URLSearchParams,
    expectedState: string,
): void {
    const states = params.getAll("state")

    if (states.length !== 1) {
        throw new Error(
            "OAuth callback must contain exactly one state parameter",
        )
    }
    if (states[0] !== expectedState) {
        throw new Error("OAuth callback state does not match")
    }
}

export function validateOAuthCallbackParams(
    params: URLSearchParams,
): void {
    const codes = params.getAll("code")
    const errors = params.getAll("error")

    if (
        codes.length + errors.length !== 1 ||
        (codes[0] ?? errors[0] ?? "").length === 0
    ) {
        throw new Error(
            "OAuth callback must contain exactly one non-empty " +
            "code or error parameter",
        )
    }

    for (const name of [
        "iss",
        "error_description",
        "error_uri",
    ]) {
        if (params.getAll(name).length > 1) {
            throw new Error(
                `OAuth callback contains duplicate ${name} parameters`,
            )
        }
    }
}

const CALLBACK_RESPONSE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Lectic authorization</title>
</head>
<body>
<h1>Authorization response received</h1>
<p>You can close this window and return to Lectic.</p>
</body>
</html>`

const DEFAULT_CALLBACK_TIMEOUT_MS = 5 * 60 * 1000

type OAuthCallbackWaitOptions = {
    timeoutMs?: number
    signal?: AbortSignal
}

export type OAuthCallbackListener = {
    callbackUrl: string
    waitForCallback(
        options?: OAuthCallbackWaitOptions,
    ): Promise<URLSearchParams>
    close(): Promise<void>
}

export function startOAuthCallbackListener(
    expectedState: () => string,
    port = 0,
): OAuthCallbackListener {
    let callbackParams: URLSearchParams | undefined
    let waiter: {
        resolve: (params: URLSearchParams) => void
        reject: (error: Error) => void
    } | undefined
    let timeout: ReturnType<typeof setTimeout> | undefined
    let waiterSignal: AbortSignal | undefined
    let closed = false

    const clearWaitResources = (): void => {
        if (timeout !== undefined) {
            clearTimeout(timeout)
            timeout = undefined
        }
        waiterSignal?.removeEventListener("abort", onAbort)
        waiterSignal = undefined
    }

    const rejectWaiter = (error: Error): void => {
        if (!waiter) return
        const pending = waiter
        waiter = undefined
        clearWaitResources()
        pending.reject(error)
    }

    const onAbort = (): void => {
        rejectWaiter(new Error("OAuth callback wait was aborted"))
    }

    const server = Bun.serve({
        hostname: "127.0.0.1",
        port,
        fetch(request) {
            const url = new URL(request.url)

            if (url.pathname === "/favicon.ico") {
                return new Response(null, { status: 404 })
            }
            if (
                request.method !== "GET" ||
                url.pathname !== "/callback"
            ) {
                return new Response("Not found", { status: 404 })
            }

            try {
                validateOAuthCallbackState(
                    url.searchParams,
                    expectedState(),
                )
                validateOAuthCallbackParams(url.searchParams)
            } catch {
                return new Response(
                    "Invalid authorization response",
                    { status: 400 },
                )
            }

            if (!callbackParams) {
                callbackParams = new URLSearchParams(
                    url.searchParams,
                )
                if (waiter) {
                    const pending = waiter
                    waiter = undefined
                    clearWaitResources()
                    pending.resolve(
                        new URLSearchParams(callbackParams),
                    )
                }
            }

            return new Response(CALLBACK_RESPONSE, {
                headers: {
                    "Cache-Control": "no-store",
                    "Content-Type":
                        "text/html; charset=utf-8",
                },
            })
        },
    })

    const callbackUrl =
        `http://127.0.0.1:${server.port}/callback`

    return {
        callbackUrl,
        waitForCallback(options = {}) {
            if (callbackParams) {
                return Promise.resolve(
                    new URLSearchParams(callbackParams),
                )
            }
            if (closed) {
                return Promise.reject(
                    new Error("OAuth callback listener is closed"),
                )
            }
            if (waiter) {
                return Promise.reject(
                    new Error("OAuth callback wait is already pending"),
                )
            }

            return new Promise<URLSearchParams>(
                (resolve, reject) => {
                    waiter = { resolve, reject }
                    const timeoutMs = options.timeoutMs ??
                        DEFAULT_CALLBACK_TIMEOUT_MS
                    timeout = setTimeout(() => {
                        rejectWaiter(new Error(
                            "Timed out waiting for OAuth callback",
                        ))
                    }, timeoutMs)
                    waiterSignal = options.signal
                    if (waiterSignal?.aborted) {
                        onAbort()
                    } else {
                        waiterSignal?.addEventListener(
                            "abort",
                            onAbort,
                            { once: true },
                        )
                    }
                },
            )
        },
        async close() {
            if (closed) return
            closed = true
            rejectWaiter(
                new Error("OAuth callback listener was closed"),
            )
            await server.stop(true)
        },
    }
}
