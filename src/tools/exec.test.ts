import { describe, it, expect } from "bun:test";
import { ExecTool } from "./exec";

function texts(results: { type: "text"; text: string }[]) {
  return results.map((r) => r.text);
}

describe("ExecTool (async)", () => {
  it("captures stdout for a simple command", async () => {
    const tool = new ExecTool({ exec: "/bin/echo", name: "echo" });
    const res = await tool.call({ arguments: ["hello"] });
    const out = texts(res).join("\n");
    expect(out).toContain("<stdout>hello\n</stdout>");
  });

  it("captures both stdout and stderr for a script", async () => {
    const script = `#!/bin/bash\n` +
      `echo "OUT"\n` +
      `echo "ERR" 1>&2\n`;
    const tool = new ExecTool({ exec: script, name: "script-io" });
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
    });
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
});
