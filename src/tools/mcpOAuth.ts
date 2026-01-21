import { join } from "path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { lecticDataDir } from "../utils/xdg";
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import open from "open";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";

export class FilePersistedOAuthClientProvider implements OAuthClientProvider {
    private _clientInformation?: OAuthClientInformationMixed;
    private _tokens?: OAuthTokens;
    private _codeVerifier?: string;
    private storagePath: string;

    constructor(
        private readonly _redirectUrl: string | URL,
        private readonly _clientMetadata: OAuthClientMetadata,
        storageId: string,
        onRedirect?: (url: URL) => void,
            public readonly clientMetadataUrl?: string
    ) {
        const dataDir = lecticDataDir();
        if (!existsSync(dataDir)) {
            mkdirSync(dataDir, { recursive: true });
        }
        // Create a safe filename from storageId (which is likely a URL hash or name)
        const safeId = storageId.replace(/[^a-zA-Z0-9]/g, "_");
        this.storagePath = join(dataDir, `mcp_oauth_${safeId}.json`);

        this.loadState();

        this._onRedirect =
            onRedirect ||
            ((url) => {
            console.log(`Opening browser for authorization: ${url.toString()}`)
            void open(url.toString()).catch(() => {
                // Ignore browser-open errors.
            })
        })
    }

    private _onRedirect: (url: URL) => void;

    private loadState() {
        if (existsSync(this.storagePath)) {
            try {
                const data = JSON.parse(readFileSync(this.storagePath, 'utf-8'));
                if (data.clientInformation) this._clientInformation = data.clientInformation;
                if (data.tokens) this._tokens = data.tokens;
                if (data.codeVerifier) this._codeVerifier = data.codeVerifier;
            } catch (e) {
                console.warn(`Failed to load OAuth state from ${this.storagePath}`, e);
            }
        }
    }

    private saveState() {
        try {
            const data = {
                clientInformation: this._clientInformation,
                tokens: this._tokens,
                codeVerifier: this._codeVerifier
            };
            writeFileSync(this.storagePath, JSON.stringify(data, null, 2));
        } catch (e) {
            console.error(`Failed to save OAuth state to ${this.storagePath}`, e);
        }
    }

    get redirectUrl(): string | URL {
        return this._redirectUrl;
    }

    get clientMetadata(): OAuthClientMetadata {
        return this._clientMetadata;
    }

    clientInformation(): OAuthClientInformationMixed | undefined {
        return this._clientInformation;
    }

    saveClientInformation(clientInformation: OAuthClientInformationMixed): void {
        this._clientInformation = clientInformation;
        this.saveState();
    }

    tokens(): OAuthTokens | undefined {
        return this._tokens;
    }

    saveTokens(tokens: OAuthTokens): void {
        this._tokens = tokens;
        this.saveState();
    }

    redirectToAuthorization(authorizationUrl: URL): void {
        this._onRedirect(authorizationUrl);
    }

    saveCodeVerifier(codeVerifier: string): void {
        this._codeVerifier = codeVerifier;
        this.saveState();
    }

    codeVerifier(): string {
        if (!this._codeVerifier) {
            // It's possible codeVerifier was loaded from disk, so we check _codeVerifier directly
            throw new Error('No code verifier saved');
        }
        return this._codeVerifier;
    }
}

export async function waitForOAuthCallback(port: number): Promise<string> {
    return new Promise<string>((resolve, reject) => {
        let isResolved = false;

        const server = Bun.serve({
            port,
            fetch(req) {
                // Ignore favicon
                if (req.url.endsWith('/favicon.ico')) {
                    return new Response(null, { status: 404 });
                }

                const url = new URL(req.url);
                const code = url.searchParams.get('code');
                const error = url.searchParams.get('error');

                if (code) {
                    if (!isResolved) {
                        isResolved = true;
                        // Allow response to be sent before stopping
                        setTimeout(() => {
                            void server.stop()
                            resolve(code)
                        }, 500);
                    }

                    return new Response(`
                                        <html>
                                        <body>
                                        <h1>Authorization Successful!</h1>
                                        <p>You can close this window and return to Lectic.</p>
                                        <script>setTimeout(() => window.close(), 2000);</script>
                                        </body>
                                        </html>
                                        `, {
                                            headers: { 'Content-Type': 'text/html' }
                                        });
                } else if (error) {
                    if (!isResolved) {
                        isResolved = true;
                        setTimeout(() => {
                            void server.stop()
                            reject(new Error(`OAuth authorization failed: ${error}`))
                        }, 500);
                    }

                    return new Response(`
                                        <html>
                                        <body>
                                        <h1>Authorization Failed</h1>
                                        <p>Error: ${error}</p>
                                        </body>
                                        </html>
                                        `, {
                                            status: 400,
                                            headers: { 'Content-Type': 'text/html' }
                                        });
                } else {
                    return new Response('Bad request', { status: 400 });
                }
            }
        });
    });
}
