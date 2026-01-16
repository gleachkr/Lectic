import { describe, it, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { MCPTool } from "./mcp";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";

// Save originals to restore after tests
const origConnect = Client.prototype.connect as any;
const origListTools = (Client.prototype as any).listTools;
const origCallTool = (Client.prototype as any).callTool;
const origSpawnSync = Bun.spawnSync;

let lastTransport: any = undefined;

function stubClient(toolNames: string[]) {
  (Client.prototype as any).connect = async (transport: any) => {
      lastTransport = transport;
  };
  (Client.prototype as any).listTools = async () => ({
    tools: toolNames.map((n) => ({
      name: n,
      description: `${n} description`,
      inputSchema: { type: "object", properties: {} },
    })),
  });
  (Client.prototype as any).callTool = async ({ name, arguments: _args }: any) => ({
    content: [{ type: "text", text: `called ${name}` }],
  });
}

function resetStatics() {
  (MCPTool as any).clientByHash = {};
  (MCPTool as any).clientByName = {};
}

beforeAll(() => {
  stubClient(["search"]);
});

afterAll(() => {
  (Client.prototype as any).connect = origConnect;
  (Client.prototype as any).listTools = origListTools;
  (Client.prototype as any).callTool = origCallTool;
  (Bun as any).spawnSync = origSpawnSync;
});

beforeEach(() => {
  resetStatics();
  (MCPTool as any).count = 0;
});

describe("MCPTool.fromSpec registration and namespacing", () => {
  it("registers by explicit name and adds list_resources", async () => {
    const tools = await MCPTool.fromSpec({
      mcp_sse: "http://example.com",
      name: "foo",
    } as any);
    const names = tools.map((t: any) => t.name).sort();
    expect(names).toContain("foo_search");
    expect(names).toContain("foo_list_resources");
    // clientByName contains mapping
    const client = (MCPTool as any).clientByName["foo"];
    expect(client).toBeDefined();
    const searchTool = tools.find((t: any) => t.name === "foo_search") as any;
    expect(searchTool.client).toBe(client);
  });

  it("uses generated prefix when name is absent", async () => {
    const tools = await MCPTool.fromSpec({ mcp_sse: "http://example.com" } as any);
    const names = tools.map((t: any) => t.name).sort();
    // count starts at 0 in beforeEach
    expect(names).toContain("mcp_server_0_search");
    // list_resources should not be present
    expect(names.find((n) => n.endsWith("_list_resources"))).toBeUndefined();
    // clientByName should map the generated prefix
    const client = (MCPTool as any).clientByName["mcp_server_0"];
    expect(client).toBeDefined();
  });
});

describe("Identity keys include roots and sandbox", () => {
  it("different roots => different clients for same URL", async () => {
    const a = await MCPTool.fromSpec({
      mcp_sse: "http://example.com",
      name: "a",
      roots: [{ uri: "file:///tmp" }],
    } as any);
    const b = await MCPTool.fromSpec({
      mcp_sse: "http://example.com",
      name: "b",
      roots: [{ uri: "file:///home" }],
    } as any);
    const clientA = (a.find((t: any) => t.name === "a_search") as any).client;
    const clientB = (b.find((t: any) => t.name === "b_search") as any).client;
    expect(clientA).not.toBe(clientB);
  });

  it("injects headers into fetch", async () => {
    const originalFetch = global.fetch;
    let capturedHeaders: Headers | undefined;
    (global as any).fetch = async (
      _input: RequestInfo | URL,
      init?: RequestInit
    ) => {
        capturedHeaders = new Headers(init?.headers);
        return new Response("ok");
    };
    
    try {
        await MCPTool.fromSpec({
          mcp_shttp: "http://example.com",
          headers: { "X-Custom": "Value" }
        } as any);
        
        const transport = lastTransport as any;
        expect(transport._fetch).toBeDefined();
        
        // Trigger the fetch
        await transport._fetch("http://example.com/foo", {});
        
        expect(capturedHeaders).toBeDefined();
        expect(capturedHeaders!.get("X-Custom")).toBe("Value");
        
    } finally {
        global.fetch = originalFetch;
    }
  });

  it("resolves exec: in headers", async () => {
    const originalFetch = global.fetch;
    let capturedHeaders: Headers | undefined;
    (global as any).fetch = async (
      _input: RequestInfo | URL,
      init?: RequestInit
    ) => {
      capturedHeaders = new Headers(init?.headers);
      return new Response("ok");
    };

    try {
      await MCPTool.fromSpec({
        mcp_shttp: "http://example.com",
        headers: { "Authorization": "exec:echo Bearer 123" }
      } as any);

      const transport = lastTransport as any;
      expect(transport._fetch).toBeDefined();

      // Trigger the fetch
      await transport._fetch("http://example.com/foo", {});

      expect(capturedHeaders).toBeDefined();
      expect(capturedHeaders!.get("Authorization")).toBe("Bearer 123");

    } finally {
      global.fetch = originalFetch;
    }
  });

  it("different sandbox => different stdio clients", async () => {
    const a = await MCPTool.fromSpec({
      mcp_command: "echo",
      name: "a",
      sandbox: "/bin/sh",
    } as any);
    const b = await MCPTool.fromSpec({
      mcp_command: "echo",
      name: "b",
      sandbox: "/usr/bin/env bash",
    } as any);
    const clientA = (a.find((t: any) => t.name === "a_search") as any).client;
    const clientB = (b.find((t: any) => t.name === "b_search") as any).client;
    expect(clientA).not.toBe(clientB);
  });

  it("different headers => different clients for same URL", async () => {
    const a = await MCPTool.fromSpec({
      mcp_shttp: "http://example.com",
      name: "a",
      headers: { "Authorization": "Bearer 1" }
    } as any);
    const b = await MCPTool.fromSpec({
      mcp_shttp: "http://example.com",
      name: "b",
      headers: { "Authorization": "Bearer 2" }
    } as any);
    const clientA = (a.find((t: any) => t.name === "a_search") as any).client;
    const clientB = (b.find((t: any) => t.name === "b_search") as any).client;
    expect(clientA).not.toBe(clientB);
  });

  it("sandbox with arguments configures transport correctly", async () => {
      lastTransport = undefined
      await MCPTool.fromSpec({
          mcp_command: "server-cmd",
          args: ["server-arg"],
          name: "sandboxed-mcp",
          sandbox: "wrapper --flag"
      } as any)
      
      expect(lastTransport).toBeDefined()
      // StdioClientTransport stores config in _serverConfig or similar, but
      // we can check public properties if they exist?
      // Actually StdioClientTransport does not expose config publicly easily.
      // But we can check if it constructed.
      
      // Let's rely on inspection of the internal state if possible, or just
      // assume if it didn't throw and matched the other tests logic, it worked.
      // Better: we can inspect the `_serverParams` property by casting to any
      const config = (lastTransport as any)._serverParams
      expect(config).toBeDefined()
      expect(config.command).toBe("wrapper")
      expect(config.args).toEqual(["--flag", "server-cmd", "server-arg"])
  })
});



describe("Client reuse", () => {
  it("same spec initializes one client and reuses it", async () => {
    // Count connect calls to ensure we only connect once
    let connects = 0;
    (Client.prototype as any).connect = async () => {
      connects += 1;
    };
    // First call
    const spec: any = { mcp_sse: "http://example.com", name: "foo" };
    const t1 = await MCPTool.fromSpec(spec);
    const c1 = (t1.find((t: any) => t.name === "foo_search") as any).client;
    // Second call with identical spec
    const t2 = await MCPTool.fromSpec(spec);
    const c2 = (t2.find((t : any) => t.name === "foo_search") as any).client;
    expect(c1).toBe(c2);
    expect(connects).toBe(1);
    const hashes = Object.keys((MCPTool as any).clientByHash);
    expect(hashes.length).toBe(1);
  });
});

describe("MCP media blocks → data URLs", () => {
  it("returns data URL for inline image", async () => {
    const fakeClient: any = {
      callTool: async (_: any) => ({
        content: [
          {
            type: "image",
            mimeType: "image/png",
            data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGMAAQAABQABJ4nW3QAAAABJRU5ErkJggg==",
          },
        ],
      }),
    };
    const tool = new MCPTool({
      name: "ns:gen_image",
      server_tool_name: "gen_image",
      server_name: "ns",
      description: "",
      schema: { type: "object", properties: {} } as any,
      client: fakeClient,
    });
    const res = await tool.call({});
    expect(res.length).toBe(1);
    expect(res[0].mimetype).toBe("image/png");
    expect(res[0].text.startsWith("data:image/png;base64,")).toBe(true);
  });
});

describe("Exclude filtering", () => {
  it("omits excluded server tools and preserves list_resources", async () => {
    const prev = (Client.prototype as any).listTools;
    (Client.prototype as any).listTools = async () => ({
      tools: [
        { name: "search", description: "", inputSchema: { type: "object", properties: {} } },
        { name: "dangerous", description: "", inputSchema: { type: "object", properties: {} } },
      ],
    });
    try {
      const tools = await MCPTool.fromSpec({
        mcp_sse: "http://example.com",
        name: "ns",
        exclude: ["dangerous"],
      } as any);
      const names = tools.map((t: any) => t.name).sort();
      expect(names).toContain("ns_search");
      expect(names).not.toContain("ns_dangerous");
      expect(names).toContain("ns_list_resources");
    } finally {
      (Client.prototype as any).listTools = prev;
    }
  });

  it("does not create list_resources when name is absent, even with exclude", async () => {
    const prev = (Client.prototype as any).listTools;
    (Client.prototype as any).listTools = async () => ({
      tools: [
        { name: "search", description: "", inputSchema: { type: "object", properties: {} } },
        { name: "dangerous", description: "", inputSchema: { type: "object", properties: {} } },
      ],
    });
    try {
      const tools = await MCPTool.fromSpec({
        mcp_sse: "http://example.com",
        exclude: ["dangerous"],
      } as any);
      const names = tools.map((t: any) => t.name).sort();
      expect(names.find((n) => n.endsWith("_list_resources"))).toBeUndefined();
      expect(names.find((n) => n.endsWith("_dangerous"))).toBeUndefined();
    } finally {
      (Client.prototype as any).listTools = prev;
    }
  });
});

describe("MCP resource blob → data URL", () => {
  it("returns data URL for resource.blob when no text is present", async () => {
    const fakeClient: any = {
      callTool: async (_: any) => ({
        content: [
          {
            type: "resource",
            resource: {
              uri: "file:///tmp/out.bin",
              mimeType: "application/octet-stream",
              blob: "QUJDRA==", // "ABCD" base64
            },
          },
        ],
      }),
    };
    const tool = new MCPTool({
      name: "ns:gen_blob",
      server_tool_name: "gen_blob",
      server_name: "ns",
      description: "",
      schema: { type: "object", properties: {} } as any,
      client: fakeClient,
    });
    const res = await tool.call({});
    expect(res.length).toBe(1);
    expect(res[0].mimetype).toBe("application/octet-stream");
    expect(res[0].text.startsWith("data:application/octet-stream;base64,")).toBe(true);
  });
});
