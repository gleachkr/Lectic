import { parseAndExpandCommand } from "../utils/execHelpers";
import { ToolCallResults, Tool, type ToolCallResult } from "../types/tool"
import type { JSONSchema, ObjectSchema } from "../types/schema"
import {
    Client,
    StreamableHTTPClientTransport,
    UnauthorizedError,
    type VersionNegotiationOptions,
} from "@modelcontextprotocol/client"
import {
    StdioClientTransport,
    getDefaultEnvironment,
} from "@modelcontextprotocol/client/stdio"
import { createFetchWithHeaderSources }
  from "../utils/fetchWithHeaders";
import { isHookSpecList, type HookSpec } from "../types/hook";
import {
    FilePersistedOAuthClientProvider,
    startOAuthCallbackListener,
    type OAuthCallbackListener,
} from "./mcpOAuth";
import { version as lecticVersion } from "../../package.json";

type MCPSpecSTDIO = {
    mcp_command: string
    args?: string[]
    env?: Record<string, string>
    sandbox?: string 
}

type MCPSpecStreamableHTTP = {
    mcp_shttp: string
    headers?: Record<string, string>
}

const MCP_PROTOCOLS = ["legacy", "auto", "2026-07-28"] as const

type MCPProtocol = typeof MCP_PROTOCOLS[number]

type MCPRoot = {
    uri: string
    name?: string
}

function isMCPRoot(raw: unknown): raw is MCPRoot {
    if (
        raw === null ||
        typeof raw !== "object" ||
        !("uri" in raw) ||
        typeof raw.uri !== "string" ||
        ("name" in raw && typeof raw.name !== "string")
    ) {
        return false
    }

    try {
        return new URL(raw.uri).protocol === "file:"
    } catch {
        return false
    }
}

function validateRoot(root: MCPRoot): void {
    if (!isMCPRoot(root)) {
        throw new Error(
            "MCP roots must contain a file: URI and an optional name",
        )
    }
}

type MCPSpec = (MCPSpecSTDIO | MCPSpecStreamableHTTP) & {
    name?: string
    icon?: string
    roots?: MCPRoot[]
    exclude?: string[]
    only?: string[]
    hooks? : HookSpec[]
    mcp_protocol?: MCPProtocol
    mcp_probe_timeout_ms?: number
}

type MCPToolSpec = {
    name: string // a namespaced-by-server name for the tool
    server_tool_name: string // the original name of the tool, known to the server
    server_name: string // the configured MCP server name (scheme prefix)
    description?: string
    icon?: string
    sandbox?: string
    schema: ObjectSchema
    client: Client
    hooks? : HookSpec[]
}

function isMCPSpecSTDIO(raw : unknown) : raw is MCPSpecSTDIO {
    return raw !== null &&
        typeof raw === "object" &&
        "mcp_command" in raw &&
         ("args" in raw 
             ? Array.isArray(raw.args) && raw.args.every(arg => typeof arg === "string") 
             : true) &&
         ("env" in raw 
             ? raw.env !== null && typeof raw.env === "object" 
             && Object.values(raw.env).every(v => typeof v === "string")
             : true
         )
}

function isMCPSpecStreamableHttp(raw : unknown) : raw is MCPSpecStreamableHTTP {
    return raw !== null &&
        typeof raw === "object" &&
        "mcp_shttp" in raw && 
        typeof raw.mcp_shttp === "string" &&
        ("headers" in raw 
            ? raw.headers !== null && typeof raw.headers === "object" 
            && Object.values(raw.headers).every(v => typeof v === "string")
            : true
        )
}

function isMCPProtocol(raw: unknown): raw is MCPProtocol {
    return typeof raw === "string" &&
        MCP_PROTOCOLS.includes(raw as MCPProtocol)
}

export function isMCPSpec(raw : unknown) : raw is MCPSpec {
    const isStdio = isMCPSpecSTDIO(raw)
    const isHttp = isMCPSpecStreamableHttp(raw)
    if (isStdio === isHttp) return false
    if (raw === null || typeof raw !== "object") return false

    return ("name" in raw ? typeof raw.name === "string" : true) &&
           ("icon" in raw ? typeof raw.icon === "string" : true) &&
           ("exclude" in raw ? Array.isArray(raw.exclude) && raw.exclude.every(s => typeof s === "string") : true) &&
           ("only" in raw ? Array.isArray(raw.only) && raw.only.every(s => typeof s === "string") : true) &&
           ("hooks" in raw ? isHookSpecList(raw.hooks) : true) &&
           ("roots" in raw
               ? Array.isArray(raw.roots) &&
                 raw.roots.every(isMCPRoot)
               : true) &&
           ("mcp_protocol" in raw
               ? isMCPProtocol(raw.mcp_protocol)
               : true) &&
           ("mcp_probe_timeout_ms" in raw
               ? typeof raw.mcp_probe_timeout_ms === "number" &&
                 Number.isSafeInteger(raw.mcp_probe_timeout_ms) &&
                 raw.mcp_probe_timeout_ms > 0
               : true)
}

function mcpOAuthStorageId(
    spec: MCPSpecStreamableHTTP,
): string {
    if (!spec.headers) return spec.mcp_shttp

    const headers = Object.entries(spec.headers)
        .map(([name, value]) => [name.toLowerCase(), value])
        .sort(([left], [right]) => left.localeCompare(right))
    return JSON.stringify([spec.mcp_shttp, headers])
}

export function mcpNegotiationOptions(
    spec: MCPSpec,
): VersionNegotiationOptions {
    const configured = spec.mcp_protocol ?? "auto"
    const mode: VersionNegotiationOptions["mode"] =
        configured === "2026-07-28"
            ? { pin: configured }
            : configured

    if (mode === "legacy") return { mode }

    const timeoutMs = spec.mcp_probe_timeout_ms ??
        ("mcp_command" in spec ? 3000 : undefined)

    return {
        mode,
        ...(timeoutMs === undefined ? {} : { probe: { timeoutMs } }),
    }
}

function isTextContent(raw : unknown) : raw is { type: "text", text: string } {
    return raw !== null && 
        typeof raw === "object" &&
        "type" in raw && raw.type === "text" &&
        "text" in raw && typeof raw.text === "string"
}

function isResourceLinkContent(raw: unknown): raw is {
    type: "resource_link",
    uri: string,
    mimeType?: string,
    name?: string,
    description?: string,
} {
    return raw !== null &&
        typeof raw === "object" &&
        "type" in raw && raw.type === "resource_link" &&
        "uri" in raw && typeof raw.uri === "string"
}

function isResourceContent(raw: unknown): raw is {
    type: "resource",
    resource: {
        uri: string,
        mimeType?: string,
        text?: string,
        blob?: string,
    }
} {
    return raw !== null &&
        typeof raw === "object" &&
        "type" in raw && raw.type === "resource" &&
        "resource" in raw && typeof raw.resource === "object" &&
        raw.resource !== null &&
        "uri" in raw.resource && typeof raw.resource.uri === "string" &&
        ("text" in raw.resource || "blob" in raw.resource)
}

function isMediaContent(raw: unknown): raw is {
    type: "image" | "audio",
    mimeType?: string,
    data: string,
} {
    return raw !== null &&
        typeof raw === "object" &&
        "type" in raw && (raw.type === "image" || raw.type === "audio") &&
        "data" in raw && typeof raw.data === "string"
}

class MCPListResources extends Tool {

    server_name: string
    kind = "mcp"
    icon: string
    description: string
    name : string
    client: Client

    constructor({
        server_name,
        client,
        icon,
        hooks
    }: {
        hooks?: HookSpec[]
        server_name: string
        client: Client
        icon?: string
    }) {
        super(hooks)
        this.client = client
        this.server_name = server_name
        this.name = `${server_name}_list_resources`
        this.icon = icon ?? ""
        // XXX: Which backends actually *require* the description field?
        this.description = 
            `This tool can be used to list resources provided by the MCP server ${server_name}. ` +
            `Results will be of two kinds, either *direct resources* or *template resources*.` +
            `Direct resources will be listed with a URI used to access the resource, the name of the resource, ` + 
            `Template resources will be listed with a URI template, name, ` +
            `and optionally a description and mimetype that applies to all matching resources.`
    };

    parameters = {
        limit: {
            type : "number",
            description : "a limit on the number of resources of each kind to be listed. 100 by default.",
        }
    } as const

    required = []

    async call(args : { limit : number | undefined }) : Promise<ToolCallResult[]> {
        const direct = await this.client.listResources()
        const template = await this.client.listResourceTemplates()
        return ToolCallResults(JSON.stringify({
            total_number_of_direct_resources: direct.resources.length,
            direct_resources: direct.resources.slice(0, args.limit ?? 100),
            total_number_of_template_resources: template.resourceTemplates.length,
            template_resources: template.resourceTemplates.slice(0, args.limit ?? 100)
        }))
    }

}

export class MCPTool extends Tool {
    name: string
    kind = "mcp"
    server_tool_name: string
    server_name: string
    description: string
    parameters: { [_ : string] : JSONSchema }
    required: string[]
    sandbox?: string
    client: Client
    static count : number = 0
    static clientByHash : Record<string, Client> = {}
    static clientByName : Record<string, Client> = {}

    icon: string

    constructor({
        name,
        server_tool_name,
        server_name,
        description,
        icon,
        schema,
        client,
        hooks
    }: MCPToolSpec) {
        super(hooks)
        this.client = client
        this.name = name
        this.server_tool_name = server_tool_name
        this.server_name = server_name
        this.icon = icon ?? ""
        // XXX: Which backends actually *require* the description field?
        this.description = description || ""

        // MCP input schemas can be broader than Lectic's internal schema
        // subset. In particular, JSON Schema permits object schemas with no
        // `properties` field when `additionalProperties` describes a map.
        // Treat the missing top-level field as an empty property map so the
        // tool can still be exposed to providers.
        this.parameters = schema.properties ?? {}
        // XXX: MCP types don't require the required property. The JSON
        // Schema spec says that when it's omitted, nothing is required
        // <https://json-schema.org/draft/2020-12/draft-bhutton-json-schema-validation-00#rfc.section.6.5>
        this.required = schema.required ?? []
    };

    private qualifyResourceUri(uri: string): string {
        if (uri.startsWith(`${this.server_name}+`)) return uri
        return `${this.server_name}+${uri}`
    }

    async call(args : Record<string, unknown>) : Promise<ToolCallResult[]> {

        this.validateArguments(args)

        const response = await this.client.callTool({ name: this.server_tool_name, arguments: args })
        const content = response.content
        const structuredContent = response.structuredContent

        if (
            !Array.isArray(content) ||
            (content.length === 0 && structuredContent === undefined)
        ) {
            throw Error(
                "<error>Unexpected MCP server tool call response: " +
                `${JSON.stringify(response)}</error>`,
            )
        }

        const results = [] as ToolCallResult[]
        for (const block of content) {
            if (isTextContent(block)) {
                results.push(...ToolCallResults(block.text))
            } else if (isResourceLinkContent(block)) {
                const mt = block.mimeType || "application/octet-stream"
                const uri = this.qualifyResourceUri(block.uri)
                results.push(...ToolCallResults(uri, mt))
            } else if (isResourceContent(block)) {
                if (block.resource.text) {
                    results.push(...ToolCallResults(block.resource.text))
                } else {
                    const mt = block.resource.mimeType || "application/octet-stream"
                    const uri = block.resource.blob 
                    ? `data:${mt};base64,${block.resource.blob}`
                    : this.qualifyResourceUri(block.resource.uri)
                    results.push(...ToolCallResults(uri, mt))
                }
            } else if (isMediaContent(block)) {
                const mt = block.mimeType || "application/octet-stream"
                const uri = `data:${mt};base64,${block.data}`
                results.push(...ToolCallResults(uri, mt))
            } else {
                throw Error(`Unsupported content block type! Got ${JSON.stringify(content)}`)
            }
        }

        if (structuredContent !== undefined) {
            results.push(...ToolCallResults(
                JSON.stringify(structuredContent),
                "application/json",
            ))
        }

        return results
    }


    static async fromSpec(spec : MCPSpec) : Promise<Tool[]> {

        const negotiation = mcpNegotiationOptions(spec)
        const transportIdent = "mcp_shttp" in spec
            ? [spec.mcp_shttp, spec.headers]
            : [spec.mcp_command, spec.args, spec.env, spec.sandbox]
        const ident = [spec.roots, negotiation, transportIdent]

        let prefix
        if (spec.name) {
            prefix = spec.name
        } else {
            prefix = `mcp_server_${MCPTool.count}`
            MCPTool.count++
        }

        const hash = String(Bun.hash(JSON.stringify(ident)))

        let client : Client

        if (hash in MCPTool.clientByHash) {
            client = MCPTool.clientByHash[hash]
            if (!(prefix in MCPTool.clientByName)) {
                MCPTool.clientByName[prefix] = client
            } else if (!(MCPTool.clientByName[prefix] === client)) {
                throw Error(`MCP server name ${prefix} is duplicated. Servers need distinct names.`)
            }
        } else {
            if (prefix in MCPTool.clientByName) {
                throw Error(
                    `MCP server name ${prefix} is duplicated. ` +
                    "Servers need distinct names.",
                )
            }

            client = new Client({
                name: "Lectic",
                version: lecticVersion,
            }, {
                capabilities: {
                    ...spec.roots ? {roots: {}} : {}
                },
                versionNegotiation: negotiation,
            })

            let transport
            let authProvider: FilePersistedOAuthClientProvider |
                undefined
            let callbackListener: OAuthCallbackListener | undefined
            let createHttpTransport: (() =>
                StreamableHTTPClientTransport) | undefined

            try {
                if ("mcp_command" in spec) {
                    if (spec.sandbox) {
                        const sandboxParts = parseAndExpandCommand(
                            spec.sandbox,
                            spec.env,
                        )
                        if (sandboxParts.length === 0) {
                            throw new Error(
                                "Sandbox command cannot be empty",
                            )
                        }
                        transport = new StdioClientTransport({
                            command: sandboxParts[0],
                            args: [
                                ...sandboxParts.slice(1),
                                spec.mcp_command,
                                ...(spec.args || []),
                            ],
                            env: {
                                ...getDefaultEnvironment(),
                                ...spec.env,
                            },
                        })
                    } else {
                        transport = new StdioClientTransport({
                            command: spec.mcp_command,
                            args: spec.args,
                            env: {
                                ...getDefaultEnvironment(),
                                ...spec.env,
                            },
                        })
                    }
                } else {
                    const serverUrl = new URL(spec.mcp_shttp)
                    callbackListener =
                        startOAuthCallbackListener(() => {
                            if (!authProvider) {
                                throw new Error(
                                    "OAuth provider is not initialized",
                                )
                            }
                            return authProvider.expectedState()
                        })
                    const clientMetadata = {
                        client_name: "Lectic MCP Client",
                        redirect_uris: [
                            callbackListener.callbackUrl,
                        ],
                        grant_types: [
                            "authorization_code",
                            "refresh_token",
                        ],
                        response_types: ["code"],
                        token_endpoint_auth_method: "none",
                    }

                    authProvider =
                        new FilePersistedOAuthClientProvider(
                            callbackListener.callbackUrl,
                            clientMetadata,
                            mcpOAuthStorageId(spec),
                        )
                    const fetchWithHeaders = spec.headers
                        ? createFetchWithHeaderSources(
                            spec.headers,
                        )
                        : undefined

                    createHttpTransport = () =>
                        new StreamableHTTPClientTransport(
                            new URL(serverUrl),
                            {
                                authProvider,
                                fetch: fetchWithHeaders,
                            },
                        )
                    transport = createHttpTransport()
                }

                const roots = spec.roots
                if (roots) {
                    roots.forEach(validateRoot)
                    client.setRequestHandler(
                        "roots/list",
                        (_request, _extra) => ({ roots }),
                    )
                }

                try {
                    await client.connect(transport)
                } catch (error) {
                    if (
                        error instanceof UnauthorizedError &&
                        transport instanceof
                            StreamableHTTPClientTransport &&
                        authProvider &&
                        callbackListener &&
                        createHttpTransport
                    ) {
                        try {
                            const callbackParams =
                                await callbackListener
                                    .waitForCallback()
                            await transport.finishAuth(
                                callbackParams,
                            )
                        } finally {
                            try {
                                authProvider.completeAuthorization()
                            } finally {
                                await transport.close()
                            }
                        }

                        await client.connect(
                            createHttpTransport(),
                        )
                    } else {
                        await transport.close().catch(() => {})
                        throw error
                    }
                }
            } finally {
                await callbackListener?.close()
            }

            MCPTool.clientByHash[hash] = client
            MCPTool.clientByName[prefix] = client
        }

        const associated_tools : Tool[] = (await client.listTools()).tools
        .filter(tool => !(spec.exclude && spec.exclude.includes(tool.name)))
        .filter(tool => !spec.only || spec.only.includes(tool.name))
        .map(tool => {
            return new MCPTool({
                name: `${prefix}_${tool.name}`,
                server_tool_name: tool.name,
                server_name: prefix,
                description: tool.description,
                icon: spec.icon,
                // ↓ We cast here. The MCP docs seem to guarantee these are schemata
                schema: tool.inputSchema as ObjectSchema,
                client: client, // the tools share a single client
                sandbox: "sandbox" in spec ? spec.sandbox : undefined,
                hooks: spec.hooks,
            })
        })

        if (spec.name) {
            associated_tools.push(new MCPListResources({
                server_name: spec.name,
                client,
                icon: spec.icon,
                hooks: spec.hooks,
            }))
        }
        
        return associated_tools 
    }
}
