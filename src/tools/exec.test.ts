import { describe, it, expect } from "bun:test";
import { ExecTool } from "./exec";
import { type ToolCallResult } from "../types/tool";

function texts(results: ToolCallResult[]) {
  return results.map((r) => r.toBlock());
}

describe("ExecTool (async)", () => {
  it("includes boilerplate in descriptions by default", () => {
    const tool = new ExecTool(
      { exec: "/bin/echo", name: "echo", usage: "Say something." },
      "Interlocutor_Name",
    );
    expect(tool.description).toContain("This tool executes the command");
    expect(tool.description).toContain("Say something.");
  });

  it("omits boilerplate when boilerplate is false", () => {
    const tool = new ExecTool(
      {
        exec: "/bin/echo",
        name: "echo",
        usage: "Say something.",
        boilerplate: false,
      },
      "Interlocutor_Name",
    );
    expect(tool.description).toBe("Say something.");
  });

  it("still includes boilerplate when boilerplate is true", () => {
    const tool = new ExecTool(
      {
        exec: "/bin/echo",
        name: "echo",
        usage: "Say something.",
        boilerplate: true,
      },
      "Interlocutor_Name",
    );
    expect(tool.description).toContain("This tool executes the command");
    expect(tool.description).toContain("Say something.");
  });

  it("uses boilerplate when usage is omitted", () => {
    const tool = new ExecTool(
      { exec: "/bin/echo", name: "echo" },
      "Interlocutor_Name",
    );
    expect(tool.description).toContain("This tool executes the command");
  });

  it("captures stdout for a simple command", async () => {
    const tool = new ExecTool(
      { exec: "/bin/echo", name: "echo" },
      "Interlocutor_Name",
    );
    const res = await tool.call({ argv: ["hello"] });
    const out = texts(res).join("\n");
    expect(out).toContain("<stdout>hello\n</stdout>");
    expect(out).toContain("<exitCode>0</exitCode>");
  });

  it("captures both stdout and stderr for a script", async () => {
    const script = `#!/bin/bash\n` + `echo "OUT"\n` + `echo "ERR" 1>&2\n`;
    const tool = new ExecTool(
      { exec: script, name: "script-io" },
      "Interlocutor_Name",
    );
    const res = await tool.call({ argv: [] });
    const out = texts(res).join("\n");
    expect(out).toContain("<stdout>OUT\n</stdout>");
    expect(out).toContain("<stderr>ERR\n</stderr>");
  });

  it(
    "times out, marks error, and includes stdout/stderr in message",
    async () => {
      const script =
        `#!/bin/bash\n` + `echo "before"\n` + `sleep 0.5\n` + `echo "after" 1>&2\n`;
      const tool = new ExecTool(
        { exec: script, name: "timeout-script", timeoutSeconds: 0.05 },
        "Interlocutor_Name",
      );
      try {
        await tool.call({ argv: [] });
        throw new Error("expected timeout");
      } catch (e) {
        expect(e).toBeInstanceOf(Error);
        const msg = (e as Error).message;
        expect(msg).toContain("<stdout>before\n</stdout>");
        expect(msg).toMatch(/timeout occurred after [0-9.]+ seconds/);
      }
    },
  );

  it("schema populates env for scripts", async () => {
    const script = `#!/bin/bash\n` + `echo "$FOO $BAR"\n`;
    const tool = new ExecTool(
      { exec: script, name: "env-script", schema: { FOO: "first", BAR: "second" } },
      "Interlocutor_Name",
    );
    const res = await tool.call({ FOO: "hello", BAR: "world" });
    const out = texts(res).join("\n");
    expect(out).toContain("<stdout>hello world\n</stdout>");
  });

  it("schema populates env for commands", async () => {
    const tool = new ExecTool(
      { exec: "/usr/bin/env", name: "env-cmd", schema: { FOO: "example" } },
      "Interlocutor_Name",
    );
    const res = await tool.call({ FOO: "BAR" });
    const out = texts(res).join("\n");
    expect(out).toMatch(/<stdout>[\s\S]*^FOO=BAR$/m);
  });

  it("stringifies non-string schema values for env vars", async () => {
    const script =
      `#!/bin/bash\n` +
      `printf '%s\\n' "$COUNT|$FLAGS|$CFG"\n`;
    const tool = new ExecTool(
      {
        exec: script,
        name: "typed-env-script",
        schema: {
          COUNT: { type: "integer" },
          FLAGS: { type: "array", items: { type: "string" } },
          CFG: {
            type: "object",
            properties: { enabled: { type: "boolean" } },
            required: ["enabled"],
          },
        },
      },
      "Interlocutor_Name",
    );
    const res = await tool.call({
      COUNT: 3,
      FLAGS: ["a", "b"],
      CFG: { enabled: true },
    });
    const out = texts(res).join("\n");
    expect(out).toContain(
      '<stdout>3|["a","b"]|{"enabled":true}\n</stdout>',
    );
  });

  it("rejects unknown keys when schema is present", async () => {
    const tool = new ExecTool(
      { exec: "/bin/echo", name: "echo", schema: { FOO: "desc" } },
      "Interlocutor_Name",
    );
    expect(tool.call({ FOO: "x", BAR: "y" } as any)).rejects.toThrow(
      /Unknown argument: BAR/,
    );
  });

  it(
    "positional argv works without schema and rejects named keys",
    async () => {
      const tool = new ExecTool(
        { exec: "/bin/echo", name: "echo" },
        "Interlocutor_Name",
      );
      const res = await tool.call({ argv: ["hi"] });
      const out = texts(res).join("\n");
      expect(out).toContain("<stdout>hi\n</stdout>");
      expect(tool.call({ FOO: "BAR" } as any)).rejects.toThrow(
        /Missing required argument: argv/,
      );
    },
  );



  it(
    "sanitizes carriage-return overwrites and ANSI sequences",
    async () => {
      const script =
        `#!/bin/bash\n` +
        // progress with CR overwrites
        `printf "\rfirst"\n` +
        `printf "\rsecond\\n"\n` +
        // red text with ANSI SGR then reset
        `printf "\x1b[31mred\x1b[0m\\n"\n`;
      const tool = new ExecTool(
        { exec: script, name: "sanitize" },
        "Interlocutor_Name",
      );
      const res = await tool.call({ argv: [] });
      const out = texts(res).join("\n");
      // After sanitization, stdout should contain the final progress line and plain text
      expect(out).toContain("<stdout>second\nred\n</stdout>");
    },
  );

  it("defaults output limit to 100k characters", () => {
    const tool = new ExecTool(
      { exec: "/bin/echo", name: "echo-default-limit" },
      "Interlocutor_Name",
    );
    expect(tool.limit).toBe(100_000);
  });

  it("truncates large output when limit is set", async () => {
    const tool = new ExecTool(
      { exec: "/bin/echo", name: "echo-limited", limit: 5 },
      "Interlocutor_Name",
    );
    const res = await tool.call({ argv: ["abcdefghij"] });
    const out = texts(res).join("\n");
    expect(out).toContain("<stdout>abcde</stdout>");
    expect(out).toContain(
      "<truncated>output exceeded 5 characters and was truncated</truncated>",
    );
  });

  it("sandbox with arguments wraps execution", async () => {
      const tool = new ExecTool(
          { 
              exec: "echo original", 
              name: "sandboxed",
              sandbox: "sh -c 'echo WRAPPED $@' --"
          }, 
          "Interlocutor_Name"
      )
      const res = await tool.call({ argv: [] })
      const out = texts(res).join("\n")
      // sh -c 'echo WRAPPED $@' -- echo original
      // Output: WRAPPED echo original
      expect(out).toContain("<stdout>WRAPPED echo original\n</stdout>")
  })

  it("sandbox works with script execution", async () => {
    // For a script, we write a temp file.
    // The sandbox should receive the script path as an argument.
    // Sandbox: sh -c 'echo WRAPPED_SCRIPT $2' --
    // Note: $1 is the interpreter (/bin/bash), $2 is the script path
    const script = `#!/bin/bash\necho "INSIDE_SCRIPT"`
    const tool = new ExecTool(
        {
            exec: script,
            name: "sandboxed-script",
            sandbox: "sh -c 'echo WRAPPED_SCRIPT $2' --"
        },
        "Interlocutor_Name"
    )
    const res = await tool.call({ argv: [] })
    const out = texts(res).join("\n")
    // Output should be WRAPPED_SCRIPT /path/to/script
    expect(out).toContain("WRAPPED_SCRIPT ")
    expect(out).toContain("/.lectic_script-")
  })
});
