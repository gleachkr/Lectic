import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const pluginRoot = resolve(import.meta.dir);
const completeScriptPath = join(pluginRoot, "scripts", "complete.sh");
const expandScriptPath = join(pluginRoot, "scripts", "expand.sh");

async function runScript(
  scriptPath: string,
  options: {
    cwd: string;
    env?: Record<string, string | undefined>;
  },
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const env = {
    ...process.env,
    ...(options.env ?? {}),
  };

  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) {
      delete env[key];
    }
  }

  const proc = Bun.spawn({
    cmd: ["bash", scriptPath],
    cwd: options.cwd,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });

  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;

  return { exitCode, stdout, stderr };
}

describe("lectic TODO plugin scripts", () => {
  test("completion script lists TODOs with surrounding context", async () => {
    const root = mkdtempSync(join(tmpdir(), "lectic-todo-plugin-"));

    try {
      mkdirSync(join(root, "src"), { recursive: true });
      mkdirSync(join(root, "ignored"), { recursive: true });

      writeFileSync(
        join(root, ".gitignore"),
        ["ignored/", ""].join("\n"),
      );
      writeFileSync(
        join(root, "src", "app.ts"),
        [
          "export function run() {",
          "  // TODO: wire this up",
          "  return 1",
          "}",
          "",
        ].join("\n"),
      );
      writeFileSync(
        join(root, "ignored", "secret.ts"),
        ["// TODO: should be ignored", ""].join("\n"),
      );

      const result = await runScript(completeScriptPath, {
        cwd: root,
        env: {
          TODO_MAX_RESULTS: "20",
          TODO_COMPLETION_CONTEXT: "1",
        },
      });

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toContain("TODO: wire this up");
      expect(result.stdout).toContain("src/app.ts:2");
      expect(result.stdout).toContain("detail: 'src/app.ts lines 1-3");
      expect(result.stdout).toContain("documentation: |");
      expect(result.stdout).toContain("```ts");
      expect(result.stdout).toContain("export function run() {");
      expect(result.stdout).toContain("  // TODO: wire this up");
      expect(result.stdout).toContain("  return 1");
      expect(result.stdout).not.toContain("ignored/secret.ts");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("expand script renders verbatim fenced context", async () => {
    const root = mkdtempSync(join(tmpdir(), "lectic-todo-expand-"));

    try {
      mkdirSync(join(root, "src"), { recursive: true });
      writeFileSync(
        join(root, "src", "app.ts"),
        [
          "const start = 1;",
          "const middle = start + 1;",
          "// TODO: validate the middle value",
          "const end = middle + 1;",
          "console.log(end);",
          "",
        ].join("\n"),
      );

      const result = await runScript(expandScriptPath, {
        cwd: root,
        env: {
          ARG: "// TODO: validate the middle value — src/app.ts:3",
          TODO_CONTEXT: "1",
        },
      });

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toContain("TODO from `src/app.ts` lines 2-4");
      expect(result.stdout).toContain("TODO at line 3");
      expect(result.stdout).toContain("```ts");
      expect(result.stdout).toContain("const middle = start + 1;");
      expect(result.stdout).toContain("// TODO: validate the middle value");
      expect(result.stdout).toContain("const end = middle + 1;");
      expect(result.stdout).not.toContain("2 | const middle = start + 1;");
      expect(result.stdout).not.toContain("3 | // TODO: validate");
      expect(result.stdout.trimEnd().endsWith("```"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("completion script times out rg after two seconds", async () => {
    const root = mkdtempSync(join(tmpdir(), "lectic-todo-timeout-"));
    const binDir = join(root, "bin");

    try {
      mkdirSync(binDir, { recursive: true });
      writeFileSync(
        join(binDir, "rg"),
        [
          "#!/usr/bin/env bash",
          "sleep 5",
          "",
        ].join("\n"),
      );
      await Bun.$`chmod +x ${join(binDir, "rg")}`;

      const started = Date.now();
      const result = await runScript(completeScriptPath, {
        cwd: root,
        env: {
          PATH: `${binDir}:${process.env.PATH ?? ""}`,
          TODO_RG_TIMEOUT_SECONDS: "2",
        },
      });
      const elapsed = Date.now() - started;

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("[]\n");
      expect(result.stderr).toContain("rg timed out after 2s");
      expect(elapsed).toBeLessThan(4500);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
