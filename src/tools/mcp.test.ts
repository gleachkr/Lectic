import { describe, it, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { MCPTool } from "./mcp";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";

// Save originals to restore after tests
const origConnect = Client.prototype.connect as any;
const origListTools = (Client.prototype as any).listTools;
const origCallTool = (Client.prototype as any).callTool;
const origSpawnSync = Bun.spawnSync;

function stubClient(toolNames: string[]) {
  (Client.prototype as any).connect = async () => {};
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
});

describe("Confirm sees namespaced tool name; server sees original name", () => {
  it("sends namespaced to confirm and original to server", async () => {
    // Build a tool manually to avoid fromSpec complexities
    const fakeClient: any = {
      callTool: async ({ name }: any) => ({ content: [{ type: "text", text: name }] }),
    };
    let seenArgs: any[] | null = null;
    (Bun as any).spawnSync = (args: any[]) => {
      seenArgs = args;
      return { exitCode: 0, stdout: new Uint8Array(), stderr: new Uint8Array() } as any;
    };
    const tool = new MCPTool({
      name: "ns:search",
      server_tool_name: "search",
      server_name: "ns",
      description: "",
      schema: { type: "object", properties: {} } as any,
      client: fakeClient,
      confirm: "dummy-confirm",
    });
    const res = await tool.call({});
    // Confirm received namespaced name
    expect(seenArgs).not.toBeNull();
    if (!seenArgs) throw new Error("confirm not called");
    expect((seenArgs as any)[0]).toBe("dummy-confirm");
    expect((seenArgs as any)[1]).toBe("ns:search");
    // Server received original tool name and echoed it in content
    const out = (res[0] as any).text as string;
    expect(out).toBe("search");
  });
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
