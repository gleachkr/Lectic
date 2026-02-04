import { parseCommandToArgv } from "../utils/execHelpers";
import { ToolCallResults, Tool, type ToolCallResult } from "../types/tool"
import type { JSONSchema, ObjectSchema } from "../types/schema"
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js"
import { WebSocketClientTransport} from "@modelcontextprotocol/sdk/client/websocket.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { ListRootsRequestSchema } from "@modelcontextprotocol/sdk/types.js"
import { expandEnv } from "../utils/replace";
import { createFetchWithHeaderSources }
  from "../utils/fetchWithHeaders";
import { isHookSpecList, type HookSpec } from "../types/hook";
import { FilePersistedOAuthClientProvider, waitForOAuthCallback }
  from "./mcpOAuth";
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

type MCPSpecWebsocket = {
    mcp_ws: string
}

type MCPRoot = {
    uri: string
    name?: string
}

function validateRoot(root : MCPRoot) {
    try {
        if ((new URL(root.uri)).protocol !== "file:") {
            throw new Error("Root URIs must be of the form 'file://…'")
        }
    } catch (e : unknown) {
        if (e instanceof Error) {
            throw new Error(`Something went wrong with the root ${JSON.stringify(root)}. Here's the Error: ${e.message}`)
        } else {
            throw new Error(`Something went wrong with the root ${JSON.stringify(root)}.`)
        }
    }
}

type MCPSpec = (MCPSpecSTDIO | MCPSpecWebsocket | MCPSpecStreamableHTTP) & { 
    name?: string
    roots?: MCPRoot[]
    exclude?: string[]
    only?: string[]
    hooks? : HookSpec[]
}

type MCPToolSpec = {
    name: string // a namespaced-by-server name for the tool
    server_tool_name: string // the original name of the tool, known to the server
    server_name: string // the configured MCP server name (scheme prefix)
    description?: string
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

function isMCPSpecWebsocket(raw : unknown) : raw is MCPSpecWebsocket {
    return raw !== null &&
        typeof raw === "object" &&
        "mcp_ws" in raw && 
        typeof raw.mcp_ws === "string" 
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

export function isMCPSpec(raw : unknown) : raw is MCPSpec {
    return (isMCPSpecSTDIO(raw) || 
            isMCPSpecWebsocket(raw) || 
            isMCPSpecStreamableHttp(raw)) && 
           ("name" in raw ? typeof raw.name === "string" : true) &&
           ("exclude" in raw ? Array.isArray(raw.exclude) && raw.exclude.every(s => typeof s === "string") : true) &&
           ("only" in raw ? Array.isArray(raw.only) && raw.only.every(s => typeof s === "string") : true) &&
           ("hooks" in raw ? isHookSpecList(raw.hooks) : true)
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
    description: string
    name : string
    client: Client

    constructor({server_name, client, hooks}: {hooks?: HookSpec[], server_name : string, client: Client}) {
        super(hooks)
        this.client = client
        this.server_name = server_name
        this.name = `${server_name}_list_resources`
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

    constructor({name, server_tool_name, server_name, description, schema, client, hooks}: MCPToolSpec) {
        super(hooks)
        this.client = client
        this.name = name
        this.server_tool_name = server_tool_name
        this.server_name = server_name
        // XXX: Which backends actually *require* the description field?
        this.description = description || ""
        
        this.parameters = schema.properties
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

        if (!Array.isArray(content) || content.length === 0) {
            throw Error(`<error>Unexpected MCP server tool call response: ${JSON.stringify(content)}</error>`)
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
        return results
    }


    static async fromSpec(spec : MCPSpec) : Promise<Tool[]> {

        const ident = [spec.roots, "mcp_sse" in spec 
            ? spec.mcp_sse
            : "mcp_shttp" in spec
            ? [spec.mcp_shttp, spec.headers]
            : "mcp_ws" in spec
            ? spec.mcp_ws
            : [spec.mcp_command, spec.args, spec.env, spec.sandbox]]

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
            client = new Client({
                name: "Lectic",
                version: lecticVersion,
            }, {
                capabilities: {
                    ...spec.roots ? {roots: {}} : {}
                }
            })

            MCPTool.clientByHash[hash] = client
            MCPTool.clientByName[prefix] = client

            let transport
            if ("mcp_command" in spec) {
                 if (spec.sandbox) {
                    const sandboxParts = parseCommandToArgv(expandEnv(spec.sandbox))
                    if (sandboxParts.length === 0) {
                        throw new Error("Sandbox command cannot be empty")
                    }
                    transport = new StdioClientTransport({
                        command: sandboxParts[0], 
                        args: [...sandboxParts.slice(1), spec.mcp_command, ...(spec.args || []) ],
                        env: {...getDefaultEnvironment(), ...spec.env}
                    })
                 } else { 
                    transport = new StdioClientTransport({ 
                        command: spec.mcp_command, 
                        args: spec.args,
                        env: {...getDefaultEnvironment(), ...spec.env}
                    })
                }
            }
            else if ("mcp_ws" in spec)
                transport = new WebSocketClientTransport(new URL(spec.mcp_ws))
            else {
                const callbackPort = 8090;
                const callbackUrl = `http://localhost:${callbackPort}/callback`;
                
                const clientMetadata = {
                    client_name: 'Lectic MCP Client',
                    redirect_uris: [callbackUrl],
                    grant_types: ['authorization_code', 'refresh_token'],
                    response_types: ['code'],
                    token_endpoint_auth_method: 'client_secret_post'
                };
                
                const authProvider = new FilePersistedOAuthClientProvider(
                    callbackUrl,
                    clientMetadata,
                    spec.mcp_shttp // use URL as storage ID
                );

                transport = new StreamableHTTPClientTransport(new URL(spec.mcp_shttp), { 
                    authProvider,
                    fetch: "headers" in spec && spec.headers
                      ? createFetchWithHeaderSources(spec.headers)
                      : undefined,
                })
            }

            if (spec.roots) {
                spec.roots.map(validateRoot)
                client.setRequestHandler(ListRootsRequestSchema, (_request, _extra) => {
                    return {
                        roots: spec.roots,
                    }
                })
            }

            try {
                await client.connect(transport)
            } catch (e) {
                const err = e as Error;
                if ((err.name === "UnauthorizedError" || e?.constructor?.name === "UnauthorizedError") 
                    && transport instanceof StreamableHTTPClientTransport
                   ) {
                    const code = await waitForOAuthCallback(8090);
                    await transport.finishAuth(code);
                    await client.connect(transport);
                } else {
                    throw e;
                }
            }
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
                // ↓ We cast here. The MCP docs seem to guarantee these are schemata
                schema: tool.inputSchema as ObjectSchema,
                client: client, // the tools share a single client
                sandbox: "sandbox" in spec ? spec.sandbox : undefined
            })
        })

        if (spec.name) {
            associated_tools.push(new MCPListResources({
                server_name: spec.name,
                client
            }))
        }
        
        return associated_tools 
    }
}
