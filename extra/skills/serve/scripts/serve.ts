#!/usr/bin/env -S lectic script

import { existsSync } from "node:fs";
import { resolve } from "node:path";

type ParsedArgs = {
  port: number;
  openBrowser: boolean;
  html?: string;
  file?: string;
  useStdin: boolean;
  help: boolean;
};

function usage(): string {
  return [
    "Usage:",
    "  serve.ts [--port N] [--no-open] (--html TEXT | --file PATH | --stdin)",
    "  serve.ts [--port N] [--no-open] [PATH]",
    "",
    "Notes:",
    "  - If no source is specified, stdin is used when available.",
    "  - The server serves one request at / and then exits.",
  ].join("\n");
}

function parsePort(raw: string): number {
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`invalid port: ${raw}`);
  }
  return port;
}

function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    port: 8080,
    openBrowser: true,
    useStdin: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    if (arg === "--help" || arg === "-h") {
      parsed.help = true;
      continue;
    }

    if (arg === "--no-open") {
      parsed.openBrowser = false;
      continue;
    }

    if (arg === "--stdin") {
      parsed.useStdin = true;
      continue;
    }

    if (arg === "--port") {
      const next = argv[++i];
      if (!next) throw new Error("--port requires a value");
      parsed.port = parsePort(next);
      continue;
    }

    if (arg === "--html") {
      const next = argv[++i];
      if (next === undefined) throw new Error("--html requires a value");
      parsed.html = next;
      continue;
    }

    if (arg === "--file") {
      const next = argv[++i];
      if (!next) throw new Error("--file requires a path");
      parsed.file = next;
      continue;
    }

    if (arg.startsWith("-")) {
      throw new Error(`unknown option: ${arg}`);
    }

    if (!parsed.file) {
      parsed.file = arg;
      continue;
    }

    throw new Error(`unexpected argument: ${arg}`);
  }

  const sourceCount =
    Number(parsed.html !== undefined) +
    Number(parsed.file !== undefined) +
    Number(parsed.useStdin);

  if (sourceCount > 1) {
    throw new Error("choose one source: --html, --file, --stdin, or positional PATH");
  }

  return parsed;
}

async function openBrowser(url: string): Promise<void> {
  const cmd = (() => {
    if (process.platform === "darwin") return ["open", url];
    if (process.platform === "win32") return ["cmd", "/c", "start", "", url];
    return ["xdg-open", url];
  })();

  try {
    const proc = Bun.spawn(cmd, {
      stdio: ["ignore", "ignore", "ignore"],
    });
    void proc.exited;
  } catch {
    // Ignore browser-open errors.
  }
}

async function loadHtml(parsed: ParsedArgs): Promise<string> {
  if (parsed.html !== undefined) {
    return parsed.html;
  }

  if (parsed.file !== undefined) {
    const path = resolve(parsed.file);
    if (!existsSync(path)) {
      throw new Error(`file does not exist: ${parsed.file}`);
    }
    return Bun.file(path).text();
  }

  if (parsed.useStdin || !process.stdin.isTTY) {
    const text = await Bun.stdin.text();
    if (text.trim() === "") {
      throw new Error("stdin was empty");
    }
    return text;
  }

  throw new Error("no HTML provided. Use --html, --file, --stdin, or pipe stdin");
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2));

  if (parsed.help) {
    console.log(usage());
    return;
  }

  const html = await loadHtml(parsed);

  let unblock: () => void = () => {};
  const blocker = new Promise<void>((resolvePromise) => {
    unblock = resolvePromise;
  });

  const server = Bun.serve({
    port: parsed.port,
    routes: {
      "/": {
        GET: () => {
          void server.stop();
          unblock();
          return new Response(html, {
            headers: {
              "Content-Type": "text/html; charset=utf-8",
            },
          });
        },
      },
    },
    fetch() {
      return new Response("Not Found", { status: 404 });
    },
  });

  const url = `http://127.0.0.1:${server.port}/`;
  console.log(`Serving page at ${url}`);

  if (parsed.openBrowser) {
    await openBrowser(url);
  } else {
    console.log("Browser launch disabled (--no-open).");
  }

  await blocker;
}

await main().catch((error: unknown) => {
  const msg = error instanceof Error ? error.message : String(error);
  console.error(`error: ${msg}`);
  console.error("");
  console.error(usage());
  process.exit(1);
});
