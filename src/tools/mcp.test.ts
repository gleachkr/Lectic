import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  isMCPSpec,
  mcpNegotiationOptions,
  MCPTool,
} from "./mcp";
import {
  Client,
  StreamableHTTPClientTransport,
  UnauthorizedError,
} from "@modelcontextprotocol/client";

// Save originals to restore after tests
const origConnect = Client.prototype.connect as any;
const origListTools = (Client.prototype as any).listTools;
const origCallTool = (Client.prototype as any).callTool;
const origFinishAuth =
  StreamableHTTPClientTransport.prototype.finishAuth;
const origSpawnSync = Bun.spawnSync;
const originalDataDir = process.env["LECTIC_DATA"];

let lastTransport: any = undefined;
let mcpDataDir: string;

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

function resetStatics() {
  (MCPTool as any).clientByHash = {};
  (MCPTool as any).clientByName = {};
}

beforeAll(() => {
  mcpDataDir = mkdtempSync(
    join(tmpdir(), "lectic-mcp-test-"),
  );
  process.env["LECTIC_DATA"] = mcpDataDir;
  stubClient(["search"]);
});

afterAll(() => {
  (Client.prototype as any).connect = origConnect;
  (Client.prototype as any).listTools = origListTools;
  (Client.prototype as any).callTool = origCallTool;
  StreamableHTTPClientTransport.prototype.finishAuth =
    origFinishAuth;
  (Bun as any).spawnSync = origSpawnSync;

  if (originalDataDir === undefined) {
    delete process.env["LECTIC_DATA"];
  } else {
    process.env["LECTIC_DATA"] = originalDataDir;
  }
  rmSync(mcpDataDir, {
    recursive: true,
    force: true,
  });
});

beforeEach(() => {
  resetStatics();
  (MCPTool as any).count = 0;
});

describe("MCP protocol negotiation", () => {
  it("defaults remote servers to automatic negotiation", () => {
    expect(mcpNegotiationOptions({
      mcp_shttp: "http://example.com",
    })).toEqual({ mode: "auto" });
  });

  it("bounds the default stdio probe timeout", () => {
    expect(mcpNegotiationOptions({
      mcp_command: "server",
    })).toEqual({
      mode: "auto",
      probe: { timeoutMs: 3000 },
    });
  });

  it("supports legacy mode and a pinned modern revision", () => {
    expect(mcpNegotiationOptions({
      mcp_command: "server",
      mcp_protocol: "legacy",
    })).toEqual({ mode: "legacy" });

    expect(mcpNegotiationOptions({
      mcp_shttp: "http://example.com",
      mcp_protocol: "2026-07-28",
      mcp_probe_timeout_ms: 1200,
    })).toEqual({
      mode: { pin: "2026-07-28" },
      probe: { timeoutMs: 1200 },
    });
  });

  it("rejects removed and invalid protocol settings", () => {
    expect(isMCPSpec({ mcp_ws: "wss://example.com" })).toBeFalse();
    expect(isMCPSpec({
      mcp_command: "server",
      mcp_shttp: "https://example.com/mcp",
    })).toBeFalse();
    expect(isMCPSpec({
      mcp_shttp: "http://example.com",
      mcp_protocol: "future",
    })).toBeFalse();
    expect(isMCPSpec({
      mcp_command: "server",
      mcp_probe_timeout_ms: 0,
    })).toBeFalse();
    expect(isMCPSpec({
      mcp_command: "server",
      roots: ["/tmp"],
    })).toBeFalse();
    expect(isMCPSpec({
      mcp_command: "server",
      roots: [{ uri: "https://example.com" }],
    })).toBeFalse();
    expect(isMCPSpec({
      mcp_command: "server",
      roots: [{ uri: "file:///tmp", name: 42 }],
    })).toBeFalse();
  });
});

describe("MCPTool.fromSpec registration and namespacing", () => {
  it("registers by explicit name and adds list_resources", async () => {
    const tools = await MCPTool.fromSpec({
      mcp_shttp: "http://example.com",
      name: "foo",
    } as any);
    const names = tools.map((t: any) => t.name).sort();
    expect(names).toContain("foo_search");
    expect(names).toContain("foo_list_resources");
    // clientByName contains mapping
    const client = (MCPTool as any).clientByName["foo"];
    expect(client).toBeDefined();
    const searchTool = tools.find(
      (t: any) => t.name === "foo_search"
    ) as any;
    expect(searchTool.client).toBe(client);
  });

  it("uses generated prefix when name is absent", async () => {
    const tools = await MCPTool.fromSpec({
      mcp_shttp: "http://example.com",
    } as any);
    const names = tools.map((t: any) => t.name).sort();
    // count starts at 0 in beforeEach
    expect(names).toContain("mcp_server_0_search");
    // list_resources should not be present
    expect(names.find((n) => n.endsWith("_list_resources"))).toBeUndefined();
    // clientByName should map the generated prefix
    const client = (MCPTool as any).clientByName["mcp_server_0"];
    expect(client).toBeDefined();
  });

  it("passes configured hooks to MCP tools and list_resources", async () => {
    const hooks = [
      {
        on: "tool_use_pre" as const,
        do: "echo ok",
      },
    ];

    const tools = await MCPTool.fromSpec({
      mcp_shttp: "http://example.com",
      name: "foo",
      hooks,
    } as any);

    const searchTool = tools.find(
      (t: any) => t.name === "foo_search"
    ) as any;
    const listTool = tools.find(
      (t: any) => t.name === "foo_list_resources"
    ) as any;

    expect(searchTool.hooks).toHaveLength(1);
    expect(searchTool.hooks[0].do).toBe("echo ok");
    expect(listTool.hooks).toHaveLength(1);
    expect(listTool.hooks[0].do).toBe("echo ok");
  });
});

describe("Identity keys include roots, sandbox, and negotiation", () => {
  it("different protocol modes use different clients", async () => {
    const automatic = await MCPTool.fromSpec({
      mcp_shttp: "http://example.com",
      name: "automatic",
    } as any);
    const legacy = await MCPTool.fromSpec({
      mcp_shttp: "http://example.com",
      name: "legacy",
      mcp_protocol: "legacy",
    } as any);
    const automaticClient = (automatic.find(
      (t: any) => t.name === "automatic_search"
    ) as any).client;
    const legacyClient = (legacy.find(
      (t: any) => t.name === "legacy_search"
    ) as any).client;
    expect(automaticClient).not.toBe(legacyClient);
  });

  it("different roots => different clients for same URL", async () => {
    const a = await MCPTool.fromSpec({
      mcp_shttp: "http://example.com",
      name: "a",
      roots: [{ uri: "file:///tmp" }],
    } as any);
    const b = await MCPTool.fromSpec({
      mcp_shttp: "http://example.com",
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
        
        const transport = lastTransport;
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

      const transport = lastTransport;
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

  it("partitions OAuth state by configured headers", async () => {
    const transports: StreamableHTTPClientTransport[] = [];
    (Client.prototype as any).connect = async (
      transport: StreamableHTTPClientTransport,
    ) => {
      transports.push(transport);
    };

    try {
      await MCPTool.fromSpec({
        mcp_shttp: "http://example.com",
        name: "first",
        headers: { "X-Tenant": "one" },
      });
      await MCPTool.fromSpec({
        mcp_shttp: "http://example.com",
        name: "second",
        headers: { "X-Tenant": "two" },
      });

      const first = (transports[0] as any)._oauthProvider;
      const second = (transports[1] as any)._oauthProvider;
      expect(first.storagePath).not.toBe(
        second.storagePath,
      );
    } finally {
      stubClient(["search"]);
    }
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
      const config = lastTransport._serverParams
      expect(config).toBeDefined()
      expect(config.command).toBe("wrapper")
      expect(config.args).toEqual(["--flag", "server-cmd", "server-arg"])
  })

  it("sandbox preserves token boundaries after env expansion", async () => {
      lastTransport = undefined
      await MCPTool.fromSpec({
          mcp_command: "server-cmd",
          args: ["server-arg"],
          name: "sandboxed-mcp-env",
          sandbox: "$WRAPPER --flag",
          env: { WRAPPER: "wrapper with spaces" },
      } as any)

      expect(lastTransport).toBeDefined()
      const config = lastTransport._serverParams
      expect(config).toBeDefined()
      expect(config.command).toBe("wrapper with spaces")
      expect(config.args).toEqual(["--flag", "server-cmd", "server-arg"])
  })
});



describe("OAuth connection lifecycle", () => {
  it("finishes the callback and reconnects a fresh transport", async () => {
    const transports: StreamableHTTPClientTransport[] = [];
    let callbackParams: URLSearchParams | undefined;
    let callbackResponseStatus: number | undefined;

    (Client.prototype as any).connect = async (
      transport: StreamableHTTPClientTransport,
    ) => {
      transports.push(transport);
      if (transports.length !== 1) return;

      const provider = (transport as any)._oauthProvider;
      const state = provider.state();
      provider.saveCodeVerifier("verifier");
      const query = new URLSearchParams({
        code: "authorization-code",
        state,
        iss: "https://auth.example.com",
      });

      const callbackUrl = String(provider.redirectUrl);
      const response = await fetch(
        `${callbackUrl}?${query}`,
      );
      callbackResponseStatus = response.status;

      throw new UnauthorizedError();
    };
    (StreamableHTTPClientTransport.prototype as any).finishAuth =
      async function (params: URLSearchParams) {
        callbackParams = params;
      };

    try {
      const tools = await MCPTool.fromSpec({
        mcp_shttp: "https://oauth.example.com/mcp",
        name: "oauth",
      } as any);

      expect(tools.map((tool: any) => tool.name)).toContain(
        "oauth_search",
      );
      expect(transports).toHaveLength(2);
      expect(transports[0]).not.toBe(transports[1]);
      expect(callbackParams?.get("code")).toBe(
        "authorization-code",
      );
      expect(callbackParams?.get("iss")).toBe(
        "https://auth.example.com",
      );
      expect(callbackResponseStatus).toBe(200);

      const provider = (transports[0] as any)._oauthProvider;
      expect(String(provider.redirectUrl)).toStartWith(
        "http://127.0.0.1:",
      );
      expect(provider.clientMetadata
        .token_endpoint_auth_method).toBe("none");
      expect(() => provider.expectedState()).toThrow(
        "No OAuth authorization is pending",
      );
      expect(() => provider.codeVerifier()).toThrow(
        "No code verifier saved",
      );
    } finally {
      StreamableHTTPClientTransport.prototype.finishAuth =
        origFinishAuth;
      stubClient(["search"]);
    }
  });
});


describe("Client reuse", () => {
  it("does not cache a client whose connection failed", async () => {
    let attempts = 0;
    (Client.prototype as any).connect = async () => {
      attempts += 1;
      if (attempts === 1) {
        throw new Error("connection failed");
      }
    };

    const spec: any = {
      mcp_shttp: "http://retry.example.com",
      name: "retry",
    };

    try {
      const connectionError = await rejectedError(
        MCPTool.fromSpec(spec),
      );
      expect(connectionError.message).toContain(
        "connection failed",
      );
      expect(Object.keys(
        (MCPTool as any).clientByHash,
      )).toHaveLength(0);
      expect((MCPTool as any).clientByName.retry)
        .toBeUndefined();

      const tools = await MCPTool.fromSpec(spec);
      expect(tools.map((tool: any) => tool.name)).toContain(
        "retry_search",
      );
      expect(attempts).toBe(2);
    } finally {
      stubClient(["search"]);
    }
  });

  it("same spec initializes one client and reuses it", async () => {
    // Count connect calls to ensure we only connect once
    let connects = 0;
    (Client.prototype as any).connect = async () => {
      connects += 1;
    };
    // First call
    const spec: any = { mcp_shttp: "http://example.com", name: "foo" };
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

describe("MCP structured output", () => {
  it("preserves every structured JSON root type", async () => {
    const values = [
      { answer: 42 },
      ["a", "b"],
      "value",
      7,
      true,
      null,
    ];

    for (const value of values) {
      const fakeClient: any = {
        callTool: async () => ({
          content: [],
          structuredContent: value,
        }),
      };
      const tool = new MCPTool({
        name: "ns_structured",
        server_tool_name: "structured",
        server_name: "ns",
        description: "",
        schema: {
          type: "object",
          properties: {},
        } as any,
        client: fakeClient,
      });

      const results = await tool.call({});
      expect(results).toHaveLength(1);
      expect(results[0].mimetype).toBe("application/json");
      expect(results[0].text).toBe(JSON.stringify(value));
    }
  });

  it("keeps textual and structured output when both exist", async () => {
    const fakeClient: any = {
      callTool: async () => ({
        content: [{ type: "text", text: "display text" }],
        structuredContent: { answer: 42 },
      }),
    };
    const tool = new MCPTool({
      name: "ns_structured",
      server_tool_name: "structured",
      server_name: "ns",
      description: "",
      schema: { type: "object", properties: {} } as any,
      client: fakeClient,
    });

    const results = await tool.call({});
    expect(results.map((result) => result.text)).toEqual([
      "display text",
      "{\"answer\":42}",
    ]);
  });

  it("still rejects a result with no content", async () => {
    const fakeClient: any = {
      callTool: async () => ({ content: [] }),
    };
    const tool = new MCPTool({
      name: "ns_empty",
      server_tool_name: "empty",
      server_name: "ns",
      description: "",
      schema: { type: "object", properties: {} } as any,
      client: fakeClient,
    });

    const error = await rejectedError(tool.call({}));
    expect(error.message).toContain(
      "Unexpected MCP server tool call response",
    );
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
        mcp_shttp: "http://example.com",
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
        mcp_shttp: "http://example.com",
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
