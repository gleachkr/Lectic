import { describe, it, expect } from "bun:test";
import { ExecTool } from "./exec";
import * as fs from "fs";

function texts(results: { type: "text"; text: string }[]) {
  return results.map((r) => r.text);
}

describe("ExecTool (async)", () => {
  it("captures stdout for a simple command", async () => {
    const tool = new ExecTool({ exec: "/bin/echo", name: "echo" }, "Interlocutor_Name");
    const res = await tool.call({ arguments: ["hello"] });
    const out = texts(res).join("\n");
    expect(out).toContain("<stdout>hello\n</stdout>");
  });

  it("captures both stdout and stderr for a script", async () => {
    const script = `#!/bin/bash\n` +
      `echo "OUT"\n` +
      `echo "ERR" 1>&2\n`;
    const tool = new ExecTool({ exec: script, name: "script-io" }, "Interlocutor_Name");
    const res = await tool.call({ arguments: [] });
    const out = texts(res).join("\n");
    expect(out).toContain("<stdout>OUT\n</stdout>");
    expect(out).toContain("<stderr>ERR\n</stderr>");
  });

  it("times out, marks error, and includes stdout/stderr in message", async () => {
    const script = `#!/bin/bash\n` +
      `echo "before"\n` +
      `sleep 0.5\n` +
      `echo "after" 1>&2\n`;
    const tool = new ExecTool({
      exec: script,
      name: "timeout-script",
      timeoutSeconds: 0.05,
    }, "Interlocutor_Name");
    try {
      await tool.call({ arguments: [] });
      throw new Error("expected timeout");
    } catch (e) {
      expect(e).toBeInstanceOf(Error);
      const msg = (e as Error).message;
      expect(msg).toContain("<stdout>before\n</stdout>");
      expect(msg).toMatch(/timeout occurred after [0-9.]+ seconds/);
    }
  });

  it("schema populates env for scripts", async () => {
    const script = `#!/bin/bash\n` +
      `echo "$FOO $BAR"\n`;
    const tool = new ExecTool({
      exec: script,
      name: "env-script",
      schema: { FOO: "first", BAR: "second" },
    }, "Interlocutor_Name");
    const res = await tool.call({ FOO: "hello", BAR: "world" });
    const out = texts(res).join("\n");
    expect(out).toContain("<stdout>hello world\n</stdout>");
  });

  it("schema populates env for commands", async () => {
    const tool = new ExecTool({
      exec: "/usr/bin/env",
      name: "env-cmd",
      schema: { FOO: "example" },
    }, "Interlocutor_Name");
    const res = await tool.call({ FOO: "BAR" });
    const out = texts(res).join("\n");
    expect(out).toMatch(/<stdout>[\s\S]*^FOO=BAR$/m);
  });

  it("rejects unknown keys when schema is present", async () => {
    const tool = new ExecTool({
      exec: "/bin/echo",
      name: "echo",
      schema: { FOO: "desc" },
    }, "Interlocutor_Name");
    await expect(tool.call({ FOO: "x", BAR: "y" } as any)).rejects.toThrow(
      /Unknown argument: BAR/
    );
  });

  it("positional argv works without schema and rejects named keys", async () => {
    const tool = new ExecTool({ exec: "/bin/echo", name: "echo" }, "Interlocutor_Name");
    const res = await tool.call({ arguments: ["hi"] });
    const out = texts(res).join("\n");
    expect(out).toContain("<stdout>hi\n</stdout>");
    await expect(tool.call({ FOO: "BAR" } as any)).rejects.toThrow(
      /Missing required argument: arguments/
    );
  });

  it("confirm receives named params JSON in schema mode", async () => {
    const confirmPath = `./.tmp-confirm-${Bun.randomUUIDv7()}.sh`;
    const capturePath = `./.confirm_capture-${Bun.randomUUIDv7()}.json`;
    const confirmScript = `#!/bin/bash\n` +
      `printf "%s" "$2" > "${capturePath}"\n` +
      `exit 0\n`;
    await Bun.write(confirmPath, confirmScript);
    fs.chmodSync(confirmPath, 0o755);

    try {
      const tool = new ExecTool({
        exec: "/bin/echo",
        name: "echo",
        confirm: confirmPath,
        schema: { FOO: "desc" },
      }, "Interlocutor_Name");

      const params = { FOO: "BAR" };
      const res = await tool.call(params);
      expect(fs.existsSync(capturePath)).toBe(true);
      const content = await Bun.file(capturePath).text();
      const parsed = JSON.parse(content);
      expect(parsed).toEqual(params);
      // also ensure the call still executed
      const out = texts(res).join("\n");
      expect(out).toContain("<stdout>\n</stdout>");
    } finally {
      if (fs.existsSync(confirmPath)) fs.unlinkSync(confirmPath);
      if (fs.existsSync(capturePath)) fs.unlinkSync(capturePath);
    }
  });
});
