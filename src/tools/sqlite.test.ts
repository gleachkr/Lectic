import { describe, it, expect } from "bun:test";
import { SQLiteTool } from "./sqlite";

function texts(results: { type: "text"; text: string }[]) {
  return results.map((r) => r.text);
}

describe("SQLiteTool result size limit", () => {
  it("throws when JSON result exceeds the configured limit", async () => {
    const tool = new SQLiteTool({ sqlite: ":memory:", name: "db", limit: 10 });
    await expect(async () => {
      await tool.call({ query: "SELECT 'abcdefghijklmnopqrstuvwxyz' AS c;" });
    }).toThrow(/result was too large/i);
  });

  it("allows results within the limit", async () => {
    const tool = new SQLiteTool({ sqlite: ":memory:", name: "db2", limit: 1000 });
    const res = await tool.call({ query: "SELECT 1 AS x;" });
    const out = texts(res).join("\n");
    expect(out).toContain("[[1]]");
  });
});
