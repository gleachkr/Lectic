import { describe, it, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SQLiteTool } from "./sqlite";
import { type ToolCallResult } from "../types/tool";
import * as YAML from "yaml";

function texts(results: ToolCallResult[]) {
  return results.map((r) => r.toBlock().text);
}

describe("SQLiteTool serialization and limits", () => {
  it("throws when YAML result exceeds the configured limit", async () => {
    const tool = new SQLiteTool({ sqlite: ":memory:", name: "db", limit: 10 });
    expect(
      tool.call({ query: "SELECT 'abcdefghijklmnopqrstuvwxyz' AS c;" })
    ).rejects.toThrow(/result was too large/i);
  });

  it("returns YAML object rows within limit", async () => {
    const tool = new SQLiteTool({ sqlite: ":memory:", name: "db2", limit: 1000 });
    const res = await tool.call({ query: "SELECT 1 AS x;" });
    const out = texts(res).join("\n");
    const parsed = YAML.parse(out);
    expect(parsed).toEqual([{ x: 1 }]);
  });

  it("yields empty array for non-SELECT statements", async () => {
    const tool = new SQLiteTool({ sqlite: ":memory:", name: "db3", limit: 1000 });
    const res = await tool.call({ query: "CREATE TABLE t(x INTEGER);" });
    const out = texts(res).join("\n");
    const parsed = YAML.parse(out);
    expect(parsed).toEqual([]);
  });

  it("is atomic across multi-statement scripts", async () => {
    const tool = new SQLiteTool({ sqlite: ":memory:", name: "db4", limit: 1000 });
    expect(
      tool.call({
        query:
          "CREATE TABLE t(x INTEGER UNIQUE);" +
          "INSERT INTO t VALUES (1);" +
          "INSERT INTO t VALUES (1);",
      })
    ).rejects.toThrow();

    const res = await tool.call({
      query:
        "SELECT name FROM sqlite_master WHERE type='table' AND name='t';",
    });
    const out = texts(res).join("\n");
    const parsed = YAML.parse(out);
    expect(parsed).toEqual([]);
  });

  it("handles multi-statement scripts", async () => {
    const tool = new SQLiteTool({ sqlite: ":memory:", name: "db5", limit: 10_000 });
    const script = [
      "DROP TABLE IF EXISTS t;",
      "CREATE TABLE t(id INTEGER PRIMARY KEY, v TEXT);",
      "INSERT INTO t(v) VALUES ('a'), ('b'), ('c');",
      "SELECT COUNT(*) AS n FROM t;",
      "UPDATE t SET v = upper(v) WHERE v = 'b';",
      "SELECT * FROM t ORDER BY id;",
      "DELETE FROM t WHERE v = 'c';",
      "SELECT v FROM t ORDER BY v;",
    ].join("");

    let res;
    for (let i = 0; i < 5; i++) {
      res = await tool.call({ query: script });
      const outs = texts(res);
      const parsed = outs.map((o) => YAML.parse(o));
      expect(parsed[3]).toEqual([{ n: 3 }]);
      expect(parsed[5]).toEqual([
        { id: 1, v: "a" },
        { id: 2, v: "B" },
        { id: 3, v: "c" },
      ]);
      expect(parsed[7]).toEqual([{ v: "B" }, { v: "a" }]);
    }
  });

  it("handles multi-statement scripts with newlines", async () => {
    const tool = new SQLiteTool({ sqlite: ":memory:", name: "db5", limit: 10_000 });
    const script = [
      "DROP TABLE IF EXISTS t;",
      "CREATE TABLE t(id INTEGER PRIMARY KEY, v TEXT);",
      "INSERT INTO t(v) VALUES ('a'), ('b'), ('c');",
      "SELECT COUNT(*) AS n FROM t;",
      "UPDATE t SET v = upper(v) WHERE v = 'b';",
      "SELECT * FROM t ORDER BY id;",
      "DELETE FROM t WHERE v = 'c';",
      "SELECT v FROM t ORDER BY v;",
    ].join("\n");

    let res;
    for (let i = 0; i < 5; i++) {
      res = await tool.call({ query: script });
      const outs = texts(res);
      const parsed = outs.map((o) => YAML.parse(o));
      expect(parsed[3]).toEqual([{ n: 3 }]);
      expect(parsed[5]).toEqual([
        { id: 1, v: "a" },
        { id: 2, v: "B" },
        { id: 3, v: "c" },
      ]);
      expect(parsed[7]).toEqual([{ v: "B" }, { v: "a" }]);
    }
  });

  it("handles multi-statement scripts with multiple newlines", async () => {
    const tool = new SQLiteTool({ sqlite: ":memory:", name: "db5", limit: 10_000 });
    const script = [
      "DROP TABLE IF EXISTS t;",
      "CREATE TABLE t(id INTEGER PRIMARY KEY, v TEXT);",
      "INSERT INTO t(v) VALUES ('a'), ('b'), ('c');",
      "SELECT COUNT(*) AS n FROM t;",
      "UPDATE t SET v = upper(v) WHERE v = 'b';",
      "SELECT * FROM t ORDER BY id;",
      "DELETE FROM t WHERE v = 'c';",
      "SELECT v FROM t ORDER BY v;",
    ].join("\n\n");

    let res;
    for (let i = 0; i < 5; i++) {
      res = await tool.call({ query: script });
      const outs = texts(res);
      const parsed = outs.map((o) => YAML.parse(o));
      expect(parsed[3]).toEqual([{ n: 3 }]);
      expect(parsed[5]).toEqual([
        { id: 1, v: "a" },
        { id: 2, v: "B" },
        { id: 3, v: "c" },
      ]);
      expect(parsed[7]).toEqual([{ v: "B" }, { v: "a" }]);
    }
  });

  it("handles multi-statement scripts with empty queries", async () => {
    const tool = new SQLiteTool({ sqlite: ":memory:", name: "db5", limit: 10_000 });
    const script = [
      "DROP TABLE IF EXISTS t;",
      "CREATE TABLE t(id INTEGER PRIMARY KEY, v TEXT);",
      "INSERT INTO t(v) VALUES ('a'), ('b'), ('c');",
      "SELECT COUNT(*) AS n FROM t;",
      ";",
      "UPDATE t SET v = upper(v) WHERE v = 'b';",
      "SELECT * FROM t ORDER BY id;",
      "DELETE FROM t WHERE v = 'c';",
      "SELECT v FROM t ORDER BY v;",
    ].join("");

    let res;
    for (let i = 0; i < 5; i++) {
      res = await tool.call({ query: script });
      const outs = texts(res);
      const parsed = outs.map((o) => YAML.parse(o));
      expect(parsed[3]).toEqual([{ n: 3 }]);
      expect(parsed[5]).toEqual([
        { id: 1, v: "a" },
        { id: 2, v: "B" },
        { id: 3, v: "c" },
      ]);
      expect(parsed[7]).toEqual([{ v: "B" }, { v: "a" }]);
    }
  });

  it("handles scripts with trailing newlines", async () => {
    const tool = new SQLiteTool({ sqlite: ":memory:", name: "db5", limit: 10_000 });
    const script = "DROP TABLE IF EXISTS t;\n"

    for (let i = 0; i < 5; i++) { await tool.call({ query: script }) }
  });

  it("handles multi-statement scripts with multiple newlines, some trailing", async () => {
    const tool = new SQLiteTool({ sqlite: ":memory:", name: "db5", limit: 10_000 });
    const script = [
      "DROP TABLE \nIF EXISTS t;",
      "CREATE TABLE t(id INTEGER PRIMARY KEY, v TEXT);",
      "INSERT INTO t(v) VALUES ('a'), ('b'), ('c');",
      "SELECT COUNT(*) \nAS n FROM t;",
      "UPDATE t SET v = upper(v) WHERE v = 'b';",
      "SELECT * \nFROM t ORDER BY id;",
      "DELETE FROM t WHERE v = 'c';",
      "SELECT v \nFROM t ORDER BY v;\n\n",
    ].join("\n\n");

    let res;
    for (let i = 0; i < 5; i++) {
      res = await tool.call({ query: script });
      const outs = texts(res);
      const parsed = outs.map((o) => YAML.parse(o));
      expect(parsed[3]).toEqual([{ n: 3 }]);
      expect(parsed[5]).toEqual([
        { id: 1, v: "a" },
        { id: 2, v: "B" },
        { id: 3, v: "c" },
      ]);
      expect(parsed[7]).toEqual([{ v: "B" }, { v: "a" }]);
    }
  });

});

describe("SQLiteTool statement safety", () => {
  it("rejects ATTACH statements", async () => {
    const tool = new SQLiteTool({ sqlite: ":memory:", name: "safe1" });
    expect(
      tool.call({ query: "ATTACH DATABASE 'evil.db' AS evil;" })
    ).rejects.toThrow(/ATTACH statements are not allowed/i);
  });

  it("rejects ATTACH without the DATABASE keyword", async () => {
    const tool = new SQLiteTool({ sqlite: ":memory:", name: "safe1b" });
    expect(tool.call({ query: "ATTACH 'evil.db' AS evil;" })).rejects.toThrow(
      /ATTACH statements are not allowed/i
    );
  });

  it("rejects DETACH statements", async () => {
    const tool = new SQLiteTool({ sqlite: ":memory:", name: "safe2" });
    expect(
      tool.call({ query: "DETACH DATABASE evil;" })
    ).rejects.toThrow(/DETACH statements are not allowed/i);
  });

  it("rejects PRAGMA statements (case-insensitive)", async () => {
    const tool = new SQLiteTool({ sqlite: ":memory:", name: "safe3" });
    expect(
      tool.call({ query: "pRaGmA user_version;" })
    ).rejects.toThrow(/PRAGMA statements are not allowed/i);
  });

  it("rejects VACUUM statements", async () => {
    const tool = new SQLiteTool({ sqlite: ":memory:", name: "safe4" });
    expect(tool.call({ query: "VACUUM;" })).rejects.toThrow(
      /VACUUM statements are not allowed/i
    );
  });

  it("rejects VACUUM INTO statements", async () => {
    const tool = new SQLiteTool({ sqlite: ":memory:", name: "safe4b" });
    expect(
      tool.call({ query: "VACUUM INTO 'evil.db';" })
    ).rejects.toThrow(/VACUUM statements are not allowed/i);
  });

  it("does not reject PRAGMA keyword in strings or comments", async () => {
    const tool = new SQLiteTool({ sqlite: ":memory:", name: "safe5" });
    const res = await tool.call({
      query: "SELECT 'PRAGMA' AS x; -- PRAGMA is in a comment\nSELECT 1 AS y;",
    });

    const outs = texts(res);
    const parsed = outs.map((o) => YAML.parse(o));
    expect(parsed).toEqual([[{ x: "PRAGMA" }], [{ y: 1 }]]);
  });

  it("blocks dangerous statements before executing any statements", async () => {
    const tool = new SQLiteTool({ sqlite: ":memory:", name: "safe6" });

    expect(
      tool.call({
        query:
          "CREATE TABLE t(x INTEGER);\n" +
          "ATTACH DATABASE 'evil.db' AS evil;\n" +
          "INSERT INTO t VALUES (1);",
      })
    ).rejects.toThrow(/ATTACH statements are not allowed/i);

    const res = await tool.call({
      query:
        "SELECT name FROM sqlite_master WHERE type='table' AND name='t';",
    });
    expect(YAML.parse(texts(res)[0])).toEqual([]);
  });
});

describe("SQLiteTool init_sql", () => {
  it("initializes a missing database file using init_sql", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lectic-sqlite-init-"));
    const dbPath = join(dir, "plugin.sqlite");

    try {
      const initSql = [
        "CREATE TABLE IF NOT EXISTS kv(k TEXT PRIMARY KEY, v TEXT);",
        "INSERT INTO kv(k, v) VALUES ('x', '1');",
      ].join("\n");

      const tool = new SQLiteTool({
        sqlite: dbPath,
        name: "init1",
        init_sql: initSql,
      });

      const res = await tool.call({
        query: "SELECT k, v FROM kv ORDER BY k;",
      });
      expect(YAML.parse(texts(res)[0])).toEqual([{ k: "x", v: "1" }]);

      tool.db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not rerun init_sql when the database file already exists", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lectic-sqlite-init-"));
    const dbPath = join(dir, "plugin.sqlite");

    try {
      const initSql = [
        "CREATE TABLE IF NOT EXISTS kv(k TEXT PRIMARY KEY, v TEXT);",
        "INSERT INTO kv(k, v) VALUES ('x', '1');",
      ].join("\n");

      const first = new SQLiteTool({
        sqlite: dbPath,
        name: "init2a",
        init_sql: initSql,
      });
      first.db.close();

      const second = new SQLiteTool({
        sqlite: dbPath,
        name: "init2b",
        init_sql: initSql,
      });
      const res = await second.call({
        query: "SELECT COUNT(*) AS n FROM kv;",
      });
      expect(YAML.parse(texts(res)[0])).toEqual([{ n: 1 }]);

      second.db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects init_sql for missing readonly databases", () => {
    const dir = mkdtempSync(join(tmpdir(), "lectic-sqlite-init-"));
    const dbPath = join(dir, "plugin.sqlite");

    try {
      expect(
        () =>
          new SQLiteTool({
            sqlite: dbPath,
            name: "init3",
            readonly: true,
            init_sql: "CREATE TABLE t(x INTEGER);",
          })
      ).toThrow(/readonly mode/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
