import { ToolCallResults, Tool, type ToolCallResult } from "../types/tool"
import type { JSONSchema } from "../types/schema"
import { lecticEnv } from "../utils/xdg";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js"
import { SSEClientTransport} from "@modelcontextprotocol/sdk/client/sse.js"
import { WebSocketClientTransport} from "@modelcontextprotocol/sdk/client/websocket.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { ListRootsRequestSchema } from "@modelcontextprotocol/sdk/types.js"
import { expandEnv } from "../utils/replace";

type MCPSpecSTDIO = {
    mcp_command: string
    args?: string[]
    env?: Record<string, string>
    sandbox?: string 
}

type MCPSpecSSE = {
    mcp_sse: string
}

type MCPSpecStreamableHTTP = {
    mcp_shttp: string
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
            throw new Error("Root URIs must be of the form 'file://…")
        }
    } catch (e : unknown) {
        if (e instanceof Error) {
            throw new Error(`Something went wrong with the root ${JSON.stringify(root)}. Here's the Error: ${e.message}`)
        } else {
            throw new Error(`Something went wrong with the root ${JSON.stringify(root)}.`)
        }
    }
}

type MCPSpec = (MCPSpecSTDIO | MCPSpecSSE | MCPSpecWebsocket | MCPSpecStreamableHTTP) & { 
    name?: string
    confirm?: string 
    roots?: MCPRoot[]
}

type MCPToolSpec = {
    name: string // a namespaced-by-server name for the tool
    server_tool_name: string // the original name of the tool, known to the server
    description?: string
    confirm?: string
    sandbox?: string
    schema: JSONSchema & { type: "object" }
    client: Client
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

function isMCPSpecSSE(raw : unknown) : raw is MCPSpecSSE {
    return raw !== null &&
        typeof raw === "object" &&
        "mcp_sse" in raw && 
        typeof raw.mcp_sse == "string" 
}

function isMCPSpecWebsocket(raw : unknown) : raw is MCPSpecWebsocket {
    return raw !== null &&
        typeof raw === "object" &&
        "mcp_ws" in raw && 
        typeof raw.mcp_ws == "string" 
}

function isMCPSpecStreamableHttp(raw : unknown) : raw is MCPSpecStreamableHTTP {
    return raw !== null &&
        typeof raw === "object" &&
        "mcp_shttp" in raw && 
        typeof raw.mcp_shttp == "string" 
}

export function isMCPSpec(raw : unknown) : raw is MCPSpec {
    return (isMCPSpecSTDIO(raw) || 
            isMCPSpecSSE(raw) || 
            isMCPSpecWebsocket(raw) || 
            isMCPSpecStreamableHttp(raw)) && 
           ("name" in raw ? typeof raw.name === "string" : true) &&
           ("confirm" in raw ? typeof raw.confirm === "string" : true)
}

function isTextContent(raw : unknown) : raw is { type: "text", text: string } {
    return raw !== null && 
        typeof raw === "object" &&
        "type" in raw && raw.type === "text" &&
        "text" in raw && typeof raw.text === "string"

}

class MCPListResources extends Tool {

    server_name: string
    description: string
    name : string
    client: Client

    constructor({server_name, client}: {server_name : string, client: Client}) {
        super()
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
    server_tool_name: string
    description: string
    parameters: { [_ : string] : JSONSchema }
    required?: string[]
    confirm?: string
    sandbox?: string
    client: Client
    static count : number = 0
    static clientByHash : Record<string, Client> = {}
    static clientByName : Record<string, Client> = {}

    constructor({name, server_tool_name, description, schema, confirm, client}: MCPToolSpec) {
        super()
        this.client = client
        this.name = name
        this.server_tool_name = server_tool_name
        this.confirm = confirm ? expandEnv(confirm) : confirm
        // XXX: Which backends actually *require* the description field?
        this.description = description || ""
        if (!schema) {
            this.parameters = {}
            this.required = []
        } else {
            this.parameters = schema.properties
            // XXX: MCP types don't include the required property. The JSON
            // Schema spec says that when it's omitted, nothing is required
            // <https://json-schema.org/draft/2020-12/draft-bhutton-json-schema-validation-00#rfc.section.6.5>
            this.required = schema.required
        }
    };

    async call(args : Record<string, unknown>) : Promise<ToolCallResult[]> {

        this.validateArguments(args)

        if (this.confirm) {
            const proc = Bun.spawnSync([this.confirm, this.name, JSON.stringify(args,null,2)],{
                env: { ...process.env, ...lecticEnv },
                stderr: "ignore" //discard stderr
            })
            if (proc.exitCode !==0) {
                throw Error(`<error>Tool use permission denied</error>`)
            }
        }

        const response = await this.client.callTool({ name: this.server_tool_name, arguments: args })
        const content = response.content

        if (!Array.isArray(content) || content.length === 0) {
            throw Error(`<error>Unexpected MCP server tool call response: ${JSON.stringify(content)}</error>`)
        } 

        let results = []
        for (const block of content) {
            if (isTextContent(block)) {
                results.push(...ToolCallResults(block.text))
            } else {
                throw Error(`MCP only supports text responses right now. Got ${JSON.stringify(content)}`)
            }
        }
        return results
    }


    static async fromSpec(spec : MCPSpec) : Promise<Tool[]> {

        const ident = [spec.roots, "mcp_sse" in spec 
            ? spec.mcp_sse
            : "mcp_shttp" in spec
            ? spec.mcp_shttp
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
                version: "0.0.0" // should draw this from package.json
            }, {
                capabilities: {
                    ...spec.roots ? {roots: {}} : {}
                }
            })

            MCPTool.clientByHash[hash] = client
            MCPTool.clientByName[prefix] = client

            const transport = "mcp_command" in spec
                ? new StdioClientTransport(spec.sandbox ? {
                    command: expandEnv(spec.sandbox), 
                    args: [spec.mcp_command, ...(spec.args || []) ],
                    env: {...getDefaultEnvironment(), ...spec.env}
                } : { 
                    command: spec.mcp_command, 
                    args: spec.args,
                    env: {...getDefaultEnvironment(), ...spec.env}
                })
                : "mcp_sse" in spec
                ? new SSEClientTransport(new URL(spec.mcp_sse))
                : "mcp_ws" in spec
                ? new WebSocketClientTransport(new URL(spec.mcp_ws))
                : new StreamableHTTPClientTransport(new URL(spec.mcp_shttp))


            if (spec.roots) {
                spec.roots.map(validateRoot)
                client.setRequestHandler(ListRootsRequestSchema, (_request, _extra) => {
                    return {
                        roots: spec.roots,
                    }
                })
            }

            await client.connect(transport)
        }

        const associated_tools : Tool[] = (await client.listTools()).tools.map(tool => {
            return new MCPTool({
                name: `${prefix}_${tool.name}`,
                server_tool_name: tool.name,
                description: tool.description,
                // ↓ We cast here. The MCP docs seem to guarantee these are schemata
                schema: tool.inputSchema as JSONSchema & { type: "object" },
                client: client, // the tools share a single client
                confirm: spec.confirm,
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
