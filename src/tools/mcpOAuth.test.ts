import {
    afterEach,
    beforeEach,
    describe,
    expect,
    test,
} from "bun:test"
import {
    chmodSync,
    mkdtempSync,
    readFileSync,
    readdirSync,
    rmSync,
    statSync,
    writeFileSync,
} from "fs"
import { tmpdir } from "os"
import { basename, join } from "path"
import {
    StreamableHTTPClientTransport,
    auth,
    type OAuthClientMetadata,
    type OAuthDiscoveryState,
    type StoredOAuthClientInformation,
    type StoredOAuthTokens,
} from "@modelcontextprotocol/client"
import {
    FilePersistedOAuthClientProvider,
    startOAuthCallbackListener,
    validateOAuthCallbackParams,
    validateOAuthCallbackState,
} from "./mcpOAuth"

const originalDataDir = process.env["LECTIC_DATA"]
const storageId = "https://mcp.example.com/rpc"
const metadata: OAuthClientMetadata = {
    client_name: "Lectic test client",
    redirect_uris: [
        "http://127.0.0.1:8090/callback",
    ],
}

let dataDir: string

function provider(
    id = storageId,
): FilePersistedOAuthClientProvider {
    return new FilePersistedOAuthClientProvider(
        metadata.redirect_uris[0],
        metadata,
        id,
        () => undefined,
    )
}

async function rejectedError(
    promise: Promise<unknown>,
): Promise<Error> {
    let rejection: unknown
    try {
        await promise
    } catch (error) {
        rejection = error
    }
    if (!(rejection instanceof Error)) {
        throw new Error("Expected promise to reject with an Error")
    }
    return rejection
}

function persistedPath(): string {
    const files = readdirSync(dataDir).filter((name) =>
        name.startsWith("mcp_oauth_") &&
        name.endsWith(".json")
    )
    expect(files).toHaveLength(1)
    return join(dataDir, files[0])
}

beforeEach(() => {
    dataDir = mkdtempSync(
        join(tmpdir(), "lectic-mcp-oauth-"),
    )
    process.env["LECTIC_DATA"] = dataDir
})

afterEach(() => {
    if (originalDataDir === undefined) {
        delete process.env["LECTIC_DATA"]
    } else {
        process.env["LECTIC_DATA"] = originalDataDir
    }
    chmodSync(dataDir, 0o700)
    rmSync(dataDir, {
        recursive: true,
        force: true,
    })
})

describe("FilePersistedOAuthClientProvider", () => {
    test("persists fresh OAuth state and the PKCE verifier", () => {
        const first = provider()
        const firstState = first.state()
        first.saveCodeVerifier("verifier")

        const restored = provider()
        expect(restored.expectedState()).toBe(firstState)
        expect(restored.codeVerifier()).toBe("verifier")

        const secondState = restored.state()
        expect(secondState).not.toBe(firstState)
        expect(provider().expectedState()).toBe(secondState)
    })

    test("completes the SDK v2 authorization flow", async () => {
        const serverUrl = new URL(
            "https://mcp-flow.example.com/mcp",
        )
        const issuer = "https://auth-flow.example.com"
        let authorizationUrl: URL | undefined
        let tokenRequest: URLSearchParams | undefined
        const flowMetadata: OAuthClientMetadata = {
            client_name: "Lectic flow test",
            redirect_uris: [
                "http://127.0.0.1:54321/callback",
            ],
            token_endpoint_auth_method: "none",
        }
        const subject =
            new FilePersistedOAuthClientProvider(
                flowMetadata.redirect_uris[0],
                flowMetadata,
                serverUrl.href,
                (url) => {
                    authorizationUrl = url
                },
            )

        const jsonResponse = (body: unknown): Response =>
            Response.json(body)
        const fetchFn = async (
            input: string | URL | Request,
            init?: RequestInit,
        ): Promise<Response> => {
            const url = new URL(String(input))

            if (url.pathname.includes(
                "oauth-protected-resource",
            )) {
                return jsonResponse({
                    resource: serverUrl.href,
                    authorization_servers: [issuer],
                    scopes_supported: ["read"],
                })
            }
            if (url.pathname.includes(
                "oauth-authorization-server",
            )) {
                return jsonResponse({
                    issuer,
                    authorization_endpoint:
                        `${issuer}/authorize`,
                    token_endpoint: `${issuer}/token`,
                    registration_endpoint:
                        `${issuer}/register`,
                    response_types_supported: ["code"],
                    token_endpoint_auth_methods_supported: [
                        "none",
                    ],
                    code_challenge_methods_supported: ["S256"],
                    authorization_response_iss_parameter_supported:
                        true,
                })
            }
            if (url.pathname === "/register") {
                const submitted = JSON.parse(
                    String(init?.body),
                ) as OAuthClientMetadata
                expect(submitted
                    .token_endpoint_auth_method).toBe("none")
                return jsonResponse({
                    ...flowMetadata,
                    client_id: "lectic-client",
                    token_endpoint_auth_method: "none",
                })
            }
            if (url.pathname === "/token") {
                tokenRequest = new URLSearchParams(
                    String(init?.body),
                )
                return jsonResponse({
                    access_token: "flow-access-token",
                    refresh_token: "flow-refresh-token",
                    token_type: "Bearer",
                })
            }

            return new Response("not found", { status: 404 })
        }

        const initial = await auth(subject, {
            serverUrl,
            fetchFn,
        })
        expect(initial).toBe("REDIRECT")
        expect(authorizationUrl).toBeDefined()
        const state = subject.expectedState()
        expect(authorizationUrl?.searchParams.get("state")).toBe(
            state,
        )

        const transport =
            new StreamableHTTPClientTransport(serverUrl, {
                authProvider: subject,
                fetch: fetchFn,
            })
        try {
            await transport.finishAuth(new URLSearchParams({
                code: "authorization-code",
                state,
                iss: issuer,
            }))
        } finally {
            await transport.close()
        }

        expect(tokenRequest?.get("code")).toBe(
            "authorization-code",
        )
        expect(tokenRequest?.get("code_verifier")).toBeTruthy()
        expect(tokenRequest?.get("client_id")).toBe(
            "lectic-client",
        )
        expect(subject.tokens()).toEqual({
            access_token: "flow-access-token",
            refresh_token: "flow-refresh-token",
            token_type: "Bearer",
            issuer,
        })
    })

    test("clears consumed state and verifier", () => {
        const first = provider()
        first.state()
        first.saveCodeVerifier("verifier")
        first.completeAuthorization()

        const restored = provider()
        expect(() => restored.expectedState()).toThrow(
            "No OAuth authorization is pending",
        )
        expect(() => restored.codeVerifier()).toThrow(
            "No code verifier saved",
        )
    })

    test("round-trips issuer-stamped credentials and discovery", () => {
        const tokens: StoredOAuthTokens = {
            access_token: "access",
            token_type: "Bearer",
            refresh_token: "refresh",
            issuer: "https://auth.example.com",
        }
        const client: StoredOAuthClientInformation = {
            client_id: "client-id",
            client_secret: "client-secret",
            issuer: "https://auth.example.com",
        }
        const discovery: OAuthDiscoveryState = {
            authorizationServerUrl:
                "https://auth.example.com",
            authorizationServerMetadata: {
                issuer: "https://auth.example.com",
                authorization_endpoint:
                    "https://auth.example.com/authorize",
                token_endpoint:
                    "https://auth.example.com/token",
                response_types_supported: ["code"],
            },
            resourceMetadata: {
                resource: "https://mcp.example.com/rpc",
                authorization_servers: [
                    "https://auth.example.com",
                ],
            },
            resourceMetadataUrl:
                "https://mcp.example.com/.well-known/" +
                "oauth-protected-resource",
        }

        const first = provider()
        first.saveTokens(tokens)
        first.saveClientInformation(client)
        first.saveDiscoveryState(discovery)

        const restored = provider()
        expect(restored.tokens()).toEqual(tokens)
        expect(restored.clientInformation()).toEqual(client)
        expect(restored.discoveryState()).toEqual(discovery)
    })

    test("invalidates each SDK credential scope", () => {
        const tokens: StoredOAuthTokens = {
            access_token: "access",
            token_type: "Bearer",
        }
        const client: StoredOAuthClientInformation = {
            client_id: "client-id",
        }
        const discovery: OAuthDiscoveryState = {
            authorizationServerUrl:
                "https://auth.example.com",
        }
        const subject = provider()

        subject.saveTokens(tokens)
        subject.saveClientInformation(client)
        subject.saveDiscoveryState(discovery)
        subject.state()
        subject.saveCodeVerifier("verifier")

        subject.invalidateCredentials("client")
        expect(subject.clientInformation()).toBeUndefined()
        expect(subject.tokens()).toEqual(tokens)

        subject.saveClientInformation(client)
        subject.invalidateCredentials("tokens")
        expect(subject.tokens()).toBeUndefined()
        expect(subject.clientInformation()).toEqual(client)

        subject.saveTokens(tokens)
        subject.invalidateCredentials("discovery")
        expect(subject.discoveryState()).toBeUndefined()
        expect(subject.codeVerifier()).toBe("verifier")

        subject.saveDiscoveryState(discovery)
        subject.invalidateCredentials("verifier")
        expect(() => subject.expectedState()).toThrow()
        expect(() => subject.codeVerifier()).toThrow()
        expect(subject.discoveryState()).toEqual(discovery)

        subject.state()
        subject.saveCodeVerifier("verifier")
        subject.invalidateCredentials("all")
        expect(subject.clientInformation()).toBeUndefined()
        expect(subject.tokens()).toBeUndefined()
        expect(subject.discoveryState()).toBeUndefined()
        expect(() => subject.expectedState()).toThrow()
        expect(() => subject.codeVerifier()).toThrow()
    })

    test("uses atomic files with restrictive permissions", () => {
        provider().saveTokens({
            access_token: "access",
            token_type: "Bearer",
        })

        const path = persistedPath()
        if (process.platform !== "win32") {
            expect(statSync(path).mode & 0o777).toBe(0o600)
        }
        expect(readdirSync(dataDir)).toEqual([
            basename(path),
        ])
    })

    test("uses distinct files for formerly colliding URLs", () => {
        const dash = provider("https://mcp.example/a-b")
        const underscore = provider("https://mcp.example/a_b")

        dash.saveTokens({
            access_token: "dash-token",
            token_type: "Bearer",
        })
        underscore.saveTokens({
            access_token: "underscore-token",
            token_type: "Bearer",
        })

        expect(provider(
            "https://mcp.example/a-b",
        ).tokens()?.access_token).toBe("dash-token")
        expect(provider(
            "https://mcp.example/a_b",
        ).tokens()?.access_token).toBe("underscore-token")
        expect(readdirSync(dataDir).filter((name) =>
            name.startsWith("mcp_oauth_")
        )).toHaveLength(2)
    })

    test("tightens and migrates an older state file", () => {
        const safeId = storageId.replace(
            /[^a-zA-Z0-9]/g,
            "_",
        )
        const path = join(
            dataDir,
            `mcp_oauth_${safeId}.json`,
        )
        writeFileSync(path, JSON.stringify({
            clientInformation: {
                client_id: "legacy-client",
            },
            tokens: {
                access_token: "legacy-access",
                token_type: "Bearer",
            },
            codeVerifier: "legacy-verifier",
        }), {
            mode: 0o644,
        })

        const restored = provider()
        const migratedPath = persistedPath()
        expect(migratedPath).not.toBe(path)
        expect(() => statSync(path)).toThrow()
        expect(restored.clientInformation()?.client_id).toBe(
            "legacy-client",
        )
        expect(restored.tokens()?.access_token).toBe(
            "legacy-access",
        )
        expect(restored.codeVerifier()).toBe(
            "legacy-verifier",
        )
        expect(restored.discoveryState()).toBeUndefined()
        if (process.platform !== "win32") {
            expect(statSync(migratedPath).mode & 0o777).toBe(
                0o600,
            )
        }
    })

    test("propagates failed token rotation and rolls back", () => {
        if (process.platform === "win32") return

        const subject = provider()
        const original: StoredOAuthTokens = {
            access_token: "old-access",
            token_type: "Bearer",
            refresh_token: "old-refresh",
        }
        subject.saveTokens(original)

        chmodSync(dataDir, 0o500)
        expect(() => subject.saveTokens({
            access_token: "new-access",
            token_type: "Bearer",
            refresh_token: "new-refresh",
        })).toThrow()
        expect(subject.tokens()).toEqual(original)

        chmodSync(dataDir, 0o700)
        expect(provider().tokens()).toEqual(original)
        expect(JSON.parse(
            readFileSync(persistedPath(), "utf8"),
        ).tokens).toEqual(original)
    })
})

describe("OAuth callback validation", () => {
    test("requires exactly one matching state", () => {
        expect(() => validateOAuthCallbackState(
            new URLSearchParams("code=x"),
            "expected",
        )).toThrow("exactly one state")

        expect(() => validateOAuthCallbackState(
            new URLSearchParams(
                "code=x&state=wrong",
            ),
            "expected",
        )).toThrow("does not match")

        expect(() => validateOAuthCallbackState(
            new URLSearchParams(
                "state=expected&state=expected",
            ),
            "expected",
        )).toThrow("exactly one state")
    })

    test("rejects ambiguous or duplicated response parameters", () => {
        expect(() => validateOAuthCallbackParams(
            new URLSearchParams("code=x&error=denied"),
        )).toThrow("exactly one non-empty")
        expect(() => validateOAuthCallbackParams(
            new URLSearchParams("code=x&code=y"),
        )).toThrow("exactly one non-empty")
        expect(() => validateOAuthCallbackParams(
            new URLSearchParams("code="),
        )).toThrow("exactly one non-empty")
        expect(() => validateOAuthCallbackParams(
            new URLSearchParams("code=x&iss=a&iss=b"),
        )).toThrow("duplicate iss")
    })

    test("accepts an immediate callback on its exact URL", async () => {
        const listener = startOAuthCallbackListener(
            () => "expected-state",
        )

        try {
            expect(listener.callbackUrl).toStartWith(
                "http://127.0.0.1:",
            )
            const mismatch = await fetch(
                listener.callbackUrl +
                "?code=wrong&state=wrong-state",
            )
            expect(mismatch.status).toBe(400)

            const query = new URLSearchParams({
                code: "authorization-code",
                state: "expected-state",
                iss: "https://auth.example.com",
                error_description:
                    "<script>alert(1)</script>",
            })
            const response = await fetch(
                `${listener.callbackUrl}?${query.toString()}`,
            )
            const body = await response.text()
            const params = await listener.waitForCallback({
                timeoutMs: 1000,
            })

            expect(response.status).toBe(200)
            expect(response.headers.get("Cache-Control")).toBe(
                "no-store",
            )
            expect(body).not.toContain(
                "<script>alert(1)</script>",
            )
            expect(params.get("code")).toBe(
                "authorization-code",
            )
            expect(params.get("iss")).toBe(
                "https://auth.example.com",
            )
        } finally {
            await listener.close()
        }
    })

    test("supports timeout, cancellation, and occupied ports", async () => {
        const timeoutListener = startOAuthCallbackListener(
            () => "state",
        )
        try {
            const error = await rejectedError(
                timeoutListener.waitForCallback({
                    timeoutMs: 5,
                }),
            )
            expect(error.message).toContain("Timed out")
        } finally {
            await timeoutListener.close()
        }

        const abortListener = startOAuthCallbackListener(
            () => "state",
        )
        const controller = new AbortController()
        controller.abort()
        try {
            const error = await rejectedError(
                abortListener.waitForCallback({
                    signal: controller.signal,
                }),
            )
            expect(error.message).toContain("aborted")
        } finally {
            await abortListener.close()
        }

        const reservation = Bun.serve({
            hostname: "127.0.0.1",
            port: 0,
            fetch: () => new Response("reserved"),
        })
        try {
            expect(() => startOAuthCallbackListener(
                () => "state",
                reservation.port,
            )).toThrow()
        } finally {
            await reservation.stop(true)
        }
    })
})
