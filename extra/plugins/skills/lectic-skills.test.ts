import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const repoRoot = resolve(import.meta.dir, "..", "..", "..");
const skillsScriptPath = resolve(import.meta.dir, "lectic-skills.ts");

function writeSkill(root: string, name: string, description: string) {
  mkdirSync(root, { recursive: true });
  const body = [
    "---",
    `name: ${name}`,
    `description: ${description}`,
    "---",
    "",
    `# ${name}`,
    "",
    "Skill body.",
    "",
  ].join("\n");

  writeFileSync(join(root, "SKILL.md"), body);
}

async function runSkills(
  args: string[],
  options?: {
    cwd?: string;
    env?: Record<string, string | undefined>;
  },
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const env = {
    ...process.env,
    ...(options?.env ?? {}),
  };

  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) {
      delete env[key];
    }
  }

  const proc = Bun.spawn({
    cmd: [process.execPath, skillsScriptPath, ...args],
    cwd: options?.cwd ?? repoRoot,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });

  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;

  return { exitCode, stdout, stderr };
}

describe("lectic skills plugin subcommand", () => {
  test("works with bundled skills from extra/skills", async () => {
    const result = await runSkills(["./extra/skills", "--", "list"], {
      cwd: repoRoot,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("- serve:");
    expect(result.stdout).toContain("- ink-tui-subcommand:");
  });

  test("uses LECTIC_RUNTIME and LECTIC_DATA when roots are omitted", async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "lectic-skills-default-roots-"));

    try {
      const runtimeRoot = join(tempRoot, "runtime");
      const dataRoot = join(tempRoot, "data");
      const serveRoot = join(runtimeRoot, "plugins", "skills", "serve");

      writeSkill(serveRoot, "serve", "Serve local HTML");
      mkdirSync(dataRoot, { recursive: true });

      const result = await runSkills(["activate", "serve"], {
        env: {
          LECTIC_RUNTIME: runtimeRoot,
          LECTIC_DATA: dataRoot,
        },
      });

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toContain("<skill>");
      expect(result.stdout).toContain(`<root>${resolve(serveRoot)}</root>`);
      expect(result.stdout).toContain("<instructions>");
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test("single bare arg is rejected without '--'", async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "lectic-skills-single-arg-"));

    try {
      const runtimeRoot = join(tempRoot, "runtime");
      const dataRoot = join(tempRoot, "data");
      const serveRoot = join(runtimeRoot, "skills", "serve");

      writeSkill(serveRoot, "serve", "Runtime serve skill");
      mkdirSync(dataRoot, { recursive: true });

      const result = await runSkills(["serve"], {
        env: {
          LECTIC_RUNTIME: runtimeRoot,
          LECTIC_DATA: dataRoot,
        },
      });

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("list does not accept");
      expect(result.stderr).toContain("ROOT ... -- list");
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test("explicit path roots require '--' separator", async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "lectic-skills-path-root-"));

    try {
      const runtimeRoot = join(tempRoot, "runtime");
      const dataRoot = join(tempRoot, "data");
      mkdirSync(runtimeRoot, { recursive: true });
      mkdirSync(dataRoot, { recursive: true });

      const localSkillDir = join(tempRoot, "local-skill");
      writeSkill(localSkillDir, "local-skill", "Local path skill");

      const explicitPath = await runSkills(["./local-skill", "--"], {
        cwd: tempRoot,
        env: {
          LECTIC_RUNTIME: runtimeRoot,
          LECTIC_DATA: dataRoot,
        },
      });

      expect(explicitPath.exitCode).toBe(0);
      expect(explicitPath.stderr).toBe("");
      expect(explicitPath.stdout.trim()).toBe("- local-skill: Local path skill");

      const missingSeparator = await runSkills(["./local-skill"], {
        cwd: tempRoot,
        env: {
          LECTIC_RUNTIME: runtimeRoot,
          LECTIC_DATA: dataRoot,
        },
      });

      expect(missingSeparator.exitCode).toBe(1);
      expect(missingSeparator.stderr).toContain("list does not accept");
      expect(missingSeparator.stderr).toContain("ROOT ... -- list");
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test("activate can target runtime skill named 'list'", async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "lectic-skills-name-list-"));

    try {
      const runtimeRoot = join(tempRoot, "runtime");
      const dataRoot = join(tempRoot, "data");
      const listRoot = join(runtimeRoot, "skills", "list");

      writeSkill(listRoot, "list", "Runtime skill named list");
      mkdirSync(dataRoot, { recursive: true });

      const listCommand = await runSkills(["list"], {
        env: {
          LECTIC_RUNTIME: runtimeRoot,
          LECTIC_DATA: dataRoot,
        },
      });
      expect(listCommand.exitCode).toBe(0);
      expect(listCommand.stderr).toBe("");
      expect(listCommand.stdout).toContain("- list: Runtime skill named list");

      const activateList = await runSkills(["activate", "list"], {
        env: {
          LECTIC_RUNTIME: runtimeRoot,
          LECTIC_DATA: dataRoot,
        },
      });
      expect(activateList.exitCode).toBe(0);
      expect(activateList.stderr).toBe("");
      expect(activateList.stdout).toContain("<skill>");
      expect(activateList.stdout).toContain(`<root>${resolve(listRoot)}</root>`);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test("bare non-runtime root args are rejected", async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "lectic-skills-bare-root-"));

    try {
      const runtimeRoot = join(tempRoot, "runtime");
      const dataRoot = join(tempRoot, "data");
      mkdirSync(runtimeRoot, { recursive: true });
      mkdirSync(dataRoot, { recursive: true });

      const result = await runSkills(["custom-skill", "--", "list"], {
        cwd: tempRoot,
        env: {
          LECTIC_RUNTIME: runtimeRoot,
          LECTIC_DATA: dataRoot,
        },
      });

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("not an explicit path");
      expect(result.stderr).toContain("./path or /path");
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test("resolves bare root args against runtime skill names", async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "lectic-skills-runtime-root-"));

    try {
      const runtimeRoot = join(tempRoot, "runtime");
      const dataRoot = join(tempRoot, "data");
      const serveRoot = join(runtimeRoot, "skills", "serve");
      const otherRoot = join(runtimeRoot, "skills", "other");

      writeSkill(serveRoot, "serve", "Runtime serve skill");
      writeSkill(otherRoot, "other", "Runtime other skill");
      mkdirSync(dataRoot, { recursive: true });

      const customRoot = join(tempRoot, "custom-skill");
      writeSkill(customRoot, "custom-skill", "Custom path skill");

      const mixedRoots = await runSkills([
        "serve",
        "./custom-skill",
        "--",
        "list",
      ], {
        cwd: tempRoot,
        env: {
          LECTIC_RUNTIME: runtimeRoot,
          LECTIC_DATA: dataRoot,
        },
      });

      expect(mixedRoots.exitCode).toBe(0);
      expect(mixedRoots.stderr).toBe("");
      expect(mixedRoots.stdout).toContain("- serve: Runtime serve skill");
      expect(mixedRoots.stdout).toContain("- custom-skill: Custom path skill");
      expect(mixedRoots.stdout).not.toContain("- other: Runtime other skill");
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test("supports '--' to force zero skill-dir arguments", async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "lectic-skills-separator-"));

    try {
      const runtimeRoot = join(tempRoot, "runtime");
      const dataRoot = join(tempRoot, "data");
      const serveRoot = join(runtimeRoot, "skills", "serve");

      writeSkill(serveRoot, "serve", "Runtime serve skill");
      mkdirSync(dataRoot, { recursive: true });

      const activateFromDefaults = await runSkills(["--", "activate", "serve"], {
        cwd: tempRoot,
        env: {
          LECTIC_RUNTIME: runtimeRoot,
          LECTIC_DATA: dataRoot,
        },
      });

      expect(activateFromDefaults.exitCode).toBe(0);
      expect(activateFromDefaults.stderr).toBe("");
      expect(activateFromDefaults.stdout).toContain("<skill>");
      expect(activateFromDefaults.stdout).toContain(
        `<root>${resolve(serveRoot)}</root>`,
      );

      const listFromDefaults = await runSkills(["--"], {
        cwd: tempRoot,
        env: {
          LECTIC_RUNTIME: runtimeRoot,
          LECTIC_DATA: dataRoot,
        },
      });

      expect(listFromDefaults.exitCode).toBe(0);
      expect(listFromDefaults.stderr).toBe("");
      expect(listFromDefaults.stdout).toContain("- serve: Runtime serve skill");
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});
