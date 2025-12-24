#!/usr/bin/env -S lectic script

import { join } from "path";
import { existsSync, readdirSync, mkdirSync } from "fs";
import { YAML } from "bun";

function parseFrontmatter(content) {
  // Match yaml frontmatter: --- (newline) content (newline) ---
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return {};
  
  try {
    return YAML.parse(match[1]) || {};
  } catch (e) {
    console.error("Failed to parse frontmatter:", e);
    return {};
  }
}

// --- Main ---

export default async function main() {
  const args = process.argv.slice(2);
  const runDir = join(process.env.LECTIC_DATA, 'run');

  // ensure run dir exists
  if (!existsSync(runDir)) {
    try { mkdirSync(runDir, { recursive: true }); } catch (e) {}
  }

  // Flags
  let list = false;
  let save = false;
  let edit = false;
  let help = false;
  
  const positional = [];
  
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--list' || arg === '-l') {
      list = true;
    } else if (arg === '--save') {
      save = true;
    } else if (arg === '--edit' || arg === '-e') {
      edit = true;
    } else if (arg === '--help' || arg === '-h') {
      help = true;
    } else {
      positional.push(arg);
    }
  }

  // Mode: List
  if (list) {
    if (!existsSync(runDir)) {
      console.log(`No templates found in ${runDir}`);
      return;
    }
    
    const files = readdirSync(runDir).filter(f => f.endsWith('.lec'));
    console.log(`Templates in ${runDir}:\n`);
    
    const maxNameLen = files.reduce((max, f) => Math.max(max, f.replace(/\.lec$/, '').length), 0);
    
    for (const file of files) {
      const name = file.replace(/\.lec$/, '');
      const content = await Bun.file(join(runDir, file)).text();
      const fm = parseFrontmatter(content);
      const tmpl = fm.template || fm._template || {};
      const desc = tmpl.description || "";
      
      console.log(`  ${name.padEnd(maxNameLen + 2)} ${desc}`);
    }
    return;
  }

  // If no args and no list, show help
  if (positional.length === 0) {
    if (!help) {
      console.log("Usage: lectic run <template> [args...]");
      console.log("       lectic run --list");
      console.log("       lectic run --edit <template>");
      console.log("       lectic run --save <template>");
    } else {
      console.log("Usage: lectic run [options] <template> [args...]");
      console.log("");
      console.log("Options:");
      console.log("  --list, -l    List available templates");
      console.log("  --edit, -e    Edit a template");
      console.log("  --save        Save template to local file and run");
      console.log("  --help, -h    Show this help message");
    }
    return;
  }

  const templateName = positional[0];
  const templatePath = join(runDir, `${templateName}.lec`);

  // Mode: Edit
  if (edit) {
    if (!templateName) {
      console.error("Error: --edit requires a template name");
      process.exit(1);
    }
    const editor = process.env.EDITOR || "vim";
    
    // Spawn editor
    const proc = Bun.spawn([editor, templatePath], {
      stdio: ["inherit", "inherit", "inherit"]
    });
    await proc.exited;
    return;
  }

  // Load Template
  if (!existsSync(templatePath)) {
    console.error(`Error: Template '${templateName}' not found in ${runDir}`);
    process.exit(1);
  }

  const content = await Bun.file(templatePath).text();
  const fm = parseFrontmatter(content);
  const tmpl = fm.template || fm._template || {};

  // Mode: Help for specific template
  if (help) {
    console.log(`Template: ${templateName}`);
    if (tmpl.description) console.log(`Description: ${tmpl.description}`);
    if (tmpl.usage) console.log(`Usage: ${tmpl.usage}`);
    return;
  }

  // Execution
  const templateArgs = positional.slice(1);
  
  // 1. Prepare Environment
  const env = { ...process.env };
  
  // Positional args ARG1, ARG2...
  templateArgs.forEach((arg, idx) => {
    env[`ARG${idx + 1}`] = arg;
  });
  
  // ARGC, ARGV, ARG_ALL
  env["ARGC"] = String(templateArgs.length);
  env["ARGV"] = templateArgs.join(" ");
  env["ARG_ALL"] = JSON.stringify(templateArgs);
  
  // Read STDIN if data available
  let stdinContent = "";
  // @ts-ignore
  if (!process.stdin.isTTY) {
     stdinContent = await Bun.stdin.text();
  }
  env["STDIN"] = stdinContent;

  // 2. Run Lectic
  
  if (save) {
    // Copy to current directory
    const dest = join(process.cwd(), `${templateName}.lec`);
    if (existsSync(dest)) {
        console.error(`Error: Destination file '${dest}' already exists.`);
        process.exit(1);
    }
    await Bun.write(dest, content);
    console.error(`Saved to ${dest}`);
    
    // Run interactively on the new file
    const proc = Bun.spawn(["lectic", "-i", dest], {
      env,
      stdio: ["inherit", "inherit", "inherit"]
    });
    await proc.exited;
    
  } else {
    // Default: Run piping content, short mode implies output to stdout
    const proc = Bun.spawn(["lectic", "-S"], {
        env,
        stdio: ["pipe", "inherit", "inherit"]
    });
    
    // Write template to stdin
    proc.stdin.write(content);
    proc.stdin.end()
    await proc.exited;

    if (process.stdout.isTTY) console.log('')
  }
}
