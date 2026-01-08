#!/usr/bin/env -S lectic script

import { YAML } from "bun";
import { readdirSync, statSync, existsSync, constants } from "node:fs";
import { basename, resolve, join, extname, relative, isAbsolute } from "node:path";

type SkillFrontmatter = {
  name?: unknown;
  description?: unknown;
  license?: unknown;
  compatibility?: unknown;
  metadata?: unknown;
  "allowed-tools"?: unknown;
};

type Skill = {
  name: string;
  description: string;
  root: string;
  skillMdPath: string;
  license?: string;
  compatibility?: string;
  allowedTools?: string;
};

const COMMANDS = new Set([
  "list",
  "activate",
  "read",
  "run",
  "help",
]);

type ParsedArgs = {
  roots: string[];
  command: string;
  rest: string[];
  json: boolean;
  prompt: boolean;
  help: boolean;
};

function usage(): string {
  return [
    "Usage:",
    "  lectic skills [SKILL_DIR ...] list [--json]",
    "  lectic skills [SKILL_DIR ...] activate <name>",
    "  lectic skills [SKILL_DIR ...] read <name> <relative-path>",
    "  lectic skills [SKILL_DIR ...] run <name> <script> [args...]",
    "  lectic skills --prompt [SKILL_DIR ...]",
    "",
    "Notes:",
    "  - SKILL_DIR may be a single skill root (contains SKILL.md),",
    "    or a directory containing multiple skill folders.",
    "  - If you configured this as an exec tool, the SKILL_DIRs are",
    "    usually baked into the tool command.",
  ].join("\n");
}

function parseArgs(argv: string[]): ParsedArgs {
  const roots: string[] = [];
  const rest: string[] = [];

  let json = false;
  let prompt = false;
  let help = false;

  let command: string | null = null;

  for (const arg of argv) {
    if (arg === "--json") {
      json = true;
      continue;
    }
    if (arg === "--prompt") {
      prompt = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      help = true;
      continue;
    }

    if (command === null && COMMANDS.has(arg)) {
      command = arg;
      continue;
    }

    if (command === null) {
      roots.push(arg);
    } else {
      rest.push(arg);
    }
  }

  if (help) {
    return { roots, command: "help", rest, json, prompt, help };
  }

  if (prompt) {
    return { roots, command: "prompt", rest, json, prompt, help };
  }

  return {
    roots,
    command: command ?? "list",
    rest,
    json,
    prompt,
    help,
  };
}

function expandEnvVars(input: string): string {
  return input.replace(/\$([A-Z0-9_]+)/g, (_m, key: string) => {
    const value = process.env[key];
    return value === undefined ? _m : value;
  });
}

function resolveRoot(input: string): string {
  return resolve(expandEnvVars(input));
}

function parseFrontmatter(text: string): {
  frontmatter: SkillFrontmatter;
  body: string;
} {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!match) {
    return { frontmatter: {}, body: text };
  }

  let fm: SkillFrontmatter = {};
  try {
    fm = (YAML.parse(match[1]) ?? {}) as SkillFrontmatter;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`failed to parse YAML frontmatter: ${msg}`);
  }

  return { frontmatter: fm, body: text.slice(match[0].length) };
}

function normalizeSkillDir(root: string): string {
  const resolved = resolveRoot(root);
  if (!existsSync(resolved)) {
    throw new Error(`skills path does not exist: ${root}`);
  }
  if (!statSync(resolved).isDirectory()) {
    throw new Error(`skills path is not a directory: ${root}`);
  }
  return resolved;
}

function validateSkillName(name: string) {
  if (name.length > 64) {
    throw new Error(`skill name too long (max 64): ${name}`);
  }

  const re = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
  if (!re.test(name)) {
    throw new Error(
      `invalid skill name '${name}' (expected lowercase a-z, 0-9, hyphens)`,
    );
  }
}

function validateSkillDescription(description: string) {
  if (description.length > 1024) {
    throw new Error("skill description too long (max 1024 chars)");
  }
}

async function loadSkillFromRootAsync(rootDir: string): Promise<Skill> {
  const root = normalizeSkillDir(rootDir);
  const skillMdPath = join(root, "SKILL.md");

  if (!existsSync(skillMdPath)) {
    throw new Error(`missing SKILL.md: ${skillMdPath}`);
  }

  const text = await Bun.file(skillMdPath).text();
  const { frontmatter, body } = parseFrontmatter(text);

  const nameRaw = frontmatter.name;
  const descRaw = frontmatter.description;

  if (typeof nameRaw !== "string" || nameRaw.trim() === "") {
    throw new Error(`SKILL.md missing required 'name' field: ${skillMdPath}`);
  }

  if (typeof descRaw !== "string" || descRaw.trim() === "") {
    throw new Error(
      `SKILL.md missing required 'description' field: ${skillMdPath}`,
    );
  }

  const name = nameRaw.trim();
  const description = descRaw.trim();

  validateSkillName(name);
  validateSkillDescription(description);

  const dirName = basename(root);
  if (dirName !== name) {
    throw new Error(
      `skill name '${name}' does not match directory '${dirName}': ${root}`,
    );
  }

  const license =
    typeof frontmatter.license === "string" ? frontmatter.license : undefined;

  const compatibility =
    typeof frontmatter.compatibility === "string"
      ? frontmatter.compatibility
      : undefined;

  const allowedTools =
    typeof frontmatter["allowed-tools"] === "string"
      ? frontmatter["allowed-tools"]
      : undefined;

  // Touch body to avoid unused warning; activation reads it separately.
  void body;

  return {
    name,
    description,
    root,
    skillMdPath,
    license,
    compatibility,
    allowedTools,
  };
}

async function discoverSkills(roots: string[]): Promise<Map<string, Skill>> {
  const skills = new Map<string, Skill>();

  for (const inputRoot of roots) {
    const root = normalizeSkillDir(inputRoot);

    const directSkillMd = join(root, "SKILL.md");
    if (existsSync(directSkillMd)) {
      const skill = await loadSkillFromRootAsync(root);
      if (skills.has(skill.name)) {
        throw new Error(`duplicate skill name '${skill.name}' in ${root}`);
      }
      skills.set(skill.name, skill);
      continue;
    }

    const entries = readdirSync(root, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith(".")) continue;

      const candidateRoot = join(root, entry.name);
      const candidateSkillMd = join(candidateRoot, "SKILL.md");
      if (!existsSync(candidateSkillMd)) continue;

      const skill = await loadSkillFromRootAsync(candidateRoot);
      if (skills.has(skill.name)) {
        throw new Error(
          `duplicate skill name '${skill.name}' in ${candidateRoot}`,
        );
      }
      skills.set(skill.name, skill);
    }
  }

  return skills;
}

function formatSkillList(skills: Map<string, Skill>): string {
  const names = [...skills.keys()].sort();
  if (names.length === 0) {
    return "No skills found.";
  }

  return names
    .map((name) => {
      const s = skills.get(name);
      if (!s) return "";
      return `- ${s.name}: ${s.description}`;
    })
    .filter(Boolean)
    .join("\n");
}

function formatPrompt(skills: Map<string, Skill>): string {
  const list = formatSkillList(skills);

  return [
    "You have access to an Agent Skills library via this tool.",
    "",
    "This tool is designed for progressive disclosure:",
    "- Pick a relevant skill from the list below (name + description).",
    "- Use 'activate <name>' to load the full SKILL.md instructions.",
    "- Use 'read <name> <relative-path>' to load referenced files.",
    "- Use 'run <name> <script> [args...]' to execute skill scripts.",
    "",
    "Available skills:",
    list,
    "",
    "Conventions:",
    "- <relative-path> must stay within the skill directory.",
    "- For scripts, <script> is resolved relative to scripts/.",
    "  (You may also pass scripts/<script>.)",
  ].join("\n");
}

function ensureRelativeWithin(root: string, relPath: string): string {
  const trimmed = relPath.trim();
  if (trimmed === "") {
    throw new Error("path must be non-empty");
  }

  if (isAbsolute(trimmed)) {
    throw new Error("path must be relative, not absolute");
  }

  const resolved = resolve(root, trimmed);
  const rel = relative(root, resolved);

  if (rel === "" || rel === ".") {
    return resolved;
  }

  if (rel.startsWith("..") || rel.includes(".." + "/") || rel.includes(".." + "\\")) {
    throw new Error(`path escapes skill root: ${relPath}`);
  }

  return resolved;
}

async function cmdActivate(skills: Map<string, Skill>, name: string) {
  const skill = skills.get(name);
  if (!skill) {
    throw new Error(`unknown skill: ${name}`);
  }

  const text = await Bun.file(skill.skillMdPath).text();
  const { frontmatter: _fm, body } = parseFrontmatter(text);

  const metaLines: string[] = [];
  metaLines.push(`name: ${skill.name}`);
  metaLines.push(`description: ${skill.description}`);

  if (skill.license) metaLines.push(`license: ${skill.license}`);
  if (skill.compatibility) metaLines.push(`compatibility: ${skill.compatibility}`);
  if (skill.allowedTools) metaLines.push(`allowed-tools: ${skill.allowedTools}`);

  process.stdout.write("<skill>\n");
  process.stdout.write(`<root>${skill.root}</root>\n`);
  process.stdout.write("<metadata>\n");
  process.stdout.write(metaLines.map((l) => `  ${l}`).join("\n"));
  process.stdout.write("\n</metadata>\n");
  process.stdout.write("<instructions>\n");
  process.stdout.write(body.trimEnd());
  process.stdout.write("\n</instructions>\n");
  process.stdout.write("</skill>\n");
}

async function cmdRead(
  skills: Map<string, Skill>,
  name: string,
  relPath: string,
) {
  const skill = skills.get(name);
  if (!skill) {
    throw new Error(`unknown skill: ${name}`);
  }

  const target = ensureRelativeWithin(skill.root, relPath);

  if (!existsSync(target)) {
    throw new Error(`file not found: ${relPath}`);
  }

  const st = statSync(target);
  if (!st.isFile()) {
    throw new Error(`not a file: ${relPath}`);
  }

  const maxBytesRaw = process.env["LECTIC_SKILLS_MAX_BYTES"];
  const maxBytes = maxBytesRaw ? Number(maxBytesRaw) : 512 * 1024;
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) {
    throw new Error("LECTIC_SKILLS_MAX_BYTES must be a positive number");
  }

  if (st.size > maxBytes) {
    throw new Error(
      `file too large (${st.size} bytes, max ${maxBytes}): ${relPath}`,
    );
  }

  const text = await Bun.file(target).text();

  process.stdout.write("<skill-file>\n");
  process.stdout.write(`<skill>${skill.name}</skill>\n`);
  process.stdout.write(`<path>${relPath}</path>\n`);
  process.stdout.write("<content>\n");
  process.stdout.write(text.trimEnd());
  process.stdout.write("\n</content>\n");
  process.stdout.write("</skill-file>\n");
}

function isExecutable(path: string): boolean {
  try {
    const mode = statSync(path).mode;
    return (mode & constants.S_IXUSR) !== 0;
  } catch {
    return false;
  }
}

async function cmdRun(
  skills: Map<string, Skill>,
  name: string,
  scriptArg: string,
  args: string[],
) {
  const skill = skills.get(name);
  if (!skill) {
    throw new Error(`unknown skill: ${name}`);
  }

  const scriptsRoot = join(skill.root, "scripts");
  if (!existsSync(scriptsRoot)) {
    throw new Error(`skill has no scripts/ directory: ${skill.name}`);
  }
  if (!statSync(scriptsRoot).isDirectory()) {
    throw new Error(`skill scripts/ is not a directory: ${skill.name}`);
  }

  const normalizedArg = scriptArg.replaceAll("\\\\", "/");
  const relFromScripts = normalizedArg.startsWith("scripts/")
    ? normalizedArg.slice("scripts/".length)
    : normalizedArg;

  const scriptRel = join("scripts", relFromScripts);
  const scriptPath = ensureRelativeWithin(scriptsRoot, relFromScripts);

  if (!existsSync(scriptPath)) {
    throw new Error(`script not found: ${scriptRel}`);
  }

  const st = statSync(scriptPath);
  if (!st.isFile()) {
    throw new Error(`not a file: ${scriptRel}`);
  }

  const env = {
    ...process.env,
    SKILL_ROOT: skill.root,
    SKILL_NAME: skill.name,
  };

  let cmd: string[];

  if (isExecutable(scriptPath)) {
    cmd = [scriptPath, ...args];
  } else {
    const ext = extname(scriptPath);
    if (ext === ".sh") {
      cmd = ["bash", scriptPath, ...args];
    } else if (ext === ".py") {
      cmd = ["python3", scriptPath, ...args];
    } else if (ext === ".js" || ext === ".ts") {
      cmd = ["lectic", "script", scriptPath, ...args];
    } else {
      throw new Error(
        `script is not executable and has unknown extension: ${scriptRel}`,
      );
    }
  }

  const proc = Bun.spawn(cmd, {
    cwd: skill.root,
    env,
    stdio: ["inherit", "inherit", "inherit"],
  });

  const exitCode = await proc.exited;
  process.exit(exitCode);
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2));

  if (parsed.command === "help") {
    console.log(usage());
    return;
  }

  if (parsed.roots.length === 0) {
    throw new Error(
      "no skills directories provided (pass one or more SKILL_DIR paths)",
    );
  }

  const skills = await discoverSkills(parsed.roots);

  if (parsed.command === "prompt") {
    console.log(formatPrompt(skills));
    return;
  }

  if (parsed.command === "list") {
    if (parsed.json) {
      const list = [...skills.values()]
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((s) => ({
          name: s.name,
          description: s.description,
          root: s.root,
          license: s.license,
          compatibility: s.compatibility,
          allowedTools: s.allowedTools,
        }));
      console.log(JSON.stringify(list, null, 2));
      return;
    }

    console.log(formatSkillList(skills));
    return;
  }

  if (parsed.command === "activate") {
    const name = parsed.rest[0];
    if (!name) throw new Error("activate requires a skill name");
    await cmdActivate(skills, name);
    return;
  }

  if (parsed.command === "read") {
    const name = parsed.rest[0];
    const relPath = parsed.rest[1];

    if (!name || !relPath) {
      throw new Error("read requires: <skill-name> <relative-path>");
    }

    await cmdRead(skills, name, relPath);
    return;
  }

  if (parsed.command === "run") {
    const name = parsed.rest[0];
    const script = parsed.rest[1];
    const args = parsed.rest.slice(2);

    if (!name || !script) {
      throw new Error("run requires: <skill-name> <script> [args...] ");
    }

    await cmdRun(skills, name, script, args);
    return;
  }

  throw new Error(`unknown command: ${parsed.command}`);
}

await main().catch((e: unknown) => {
  const msg = e instanceof Error ? e.message : String(e);
  console.error(`error: ${msg}`);
  console.error("");
  console.error(usage());
  process.exit(1);
});
