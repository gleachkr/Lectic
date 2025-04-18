import { Tool } from "../types/tool"
import type { JSONSchema } from "../types/schema"
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js"
import { SSEClientTransport} from "@modelcontextprotocol/sdk/client/sse.js"
import { WebSocketClientTransport} from "@modelcontextprotocol/sdk/client/websocket.js"

type MCPSpecSTDIO = {
    mcp_command: string
    args?: string[]
    env?: { [key: string] : string }
    sandbox?: string 
}

type MCPSpecSSE = {
    mcp_sse: string
}

type MCPSpecWebsocket = {
    mcp_ws: string
}

type MCPSpec = (MCPSpecSTDIO | MCPSpecSSE | MCPSpecWebsocket) & { 
    confirm?: string 
}

type MCPToolSpec = {
    name: string
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

export function isMCPSpec(raw : unknown) : raw is MCPSpec {
    return (isMCPSpecSTDIO(raw) || isMCPSpecSSE(raw) || isMCPSpecWebsocket(raw)) 
        && ("confirm" in raw ? typeof raw.confirm === "string" : true)
}

function isTextContent(raw : unknown) : raw is { type: "text", text: string } {
    return raw !== null && 
        typeof raw === "object" &&
        "type" in raw && raw.type === "text" &&
        "text" in raw && typeof raw.text === "string"

}

export class MCPTool extends Tool {
    name: string
    description: string
    parameters: { [_ : string] : JSONSchema }
    required?: string[]
    confirm?: string
    sandbox?: string
    client: Client

    constructor({name, description, schema, confirm, client}: MCPToolSpec) {
        super()
        this.client = client
        this.name = name
        this.confirm = confirm
        // XXX: Which backends actually *require* the description field?
        this.description = description || ""
        if (!schema) {
            this.parameters = {}
            this.required = []
        } else {
            // We cast here. The MCP docs seem to guarantee these are schemata
            this.parameters = schema.properties
            // XXX: MCP types don't include the required property. The JSON
            // Schema spec says that when it's omitted, nothing is required
            // <https://json-schema.org/draft/2020-12/draft-bhutton-json-schema-validation-00#rfc.section.6.5>
            this.required = schema.required
        }
        this.register()
    };

    async call(args : {[key : string] : unknown}) : Promise<string> {
        if (this.confirm) {
            const proc = Bun.spawnSync([this.confirm, this.name, JSON.stringify(args,null,2)])
            if (proc.exitCode !==0) {
                throw Error(`<error>Tool use permission denied</error>`)
            }
        }

        const response = await this.client.callTool({ name: this.name, arguments: args })
        const content = response.content
        if (!Array.isArray(content) || content.length === 0) {
            throw Error(`<error>Unexpected MCP server tool call response: ${JSON.stringify(content)}`)
        } else {
            let result = ""
            for (const block of content) {
                if (isTextContent(block)) {
                    result += (`<part>${block.text}</part>`)
                } else {
                    throw Error(`<error>MCP only supports text responses right now. Got ${JSON.stringify(content)}`)
                }
            }
            return result
        }
    }

    static async fromSpec(spec : MCPSpec) : Promise<MCPTool[]> {
        const transport = "mcp_command" in spec
            ? new StdioClientTransport(spec.sandbox ? {
                command: spec.sandbox, 
                args: [spec.mcp_command, ...(spec.args || []) ],
                env: {...getDefaultEnvironment(), ...spec.env}
            } : { 
                command: spec.mcp_command, 
                args: spec.args,
                env: {...getDefaultEnvironment(), ...spec.env}
            })
            : "mcp_sse" in spec
            ? new SSEClientTransport(new URL(spec.mcp_sse))
            : new WebSocketClientTransport(new URL(spec.mcp_ws))

        const client = new Client({
            name: "Lectic",
            version: "0.0.0"
        }, {
            capabilities: {}
        })

        await client.connect(transport)

        return (await client.listTools()).tools.map(tool => {
            return new MCPTool({
                name: tool.name,
                description: tool.description,
                schema: tool.inputSchema as JSONSchema & { type: "object" },
                client: client, // the tools share a single client
                confirm: spec.confirm,
                sandbox: "sandbox" in spec ? spec.sandbox : undefined
            })
        })
    }
}
