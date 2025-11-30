import { describe, it, expect } from "bun:test";
import { ExecTool } from "./exec";
import { ToolCallResult } from "../types/tool";

function texts(results: ToolCallResult[]) {
  return results.map((r) => r.toBlock());
}

describe("ExecTool (async)", () => {
  it("captures stdout for a simple command", async () => {
    const tool = new ExecTool(
      { exec: "/bin/echo", name: "echo" },
      "Interlocutor_Name",
    );
    const res = await tool.call({ argv: ["hello"] });
    const out = texts(res).join("\n");
    expect(out).toContain("<stdout>hello\n</stdout>");
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
});
