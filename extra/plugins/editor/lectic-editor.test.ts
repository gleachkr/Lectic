import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"

import { editorBridgeSocketPath } from "../../../src/lsp/editorBridge"

import {
  maybeChecktimeParentNvim,
  parentNvimChecktimeCommand,
} from "./lib"

type BridgeRequest = {
  id?: string
  type?: string
  params?: Record<string, unknown>
}

const repoRoot = resolve(import.meta.dir, "..", "..", "..")
const editorScriptPath = resolve(import.meta.dir, "./lectic-editor.ts")
const toolProgressStartPath = resolve(
  import.meta.dir,
  "./scripts/tool-progress-start.ts"
)
const toolApprovePath = resolve(import.meta.dir, "./scripts/tool-approve.ts")

async function withFakeBridge(
  socketPath: string,
  handler: (request: BridgeRequest) => unknown | Promise<unknown>,
  fn: () => Promise<void>
): Promise<void> {
  const server = createServer((socket) => {
    socket.setEncoding("utf8")
    let buffer = ""

    socket.on("data", async (chunk: string) => {
      buffer += chunk
      const newline = buffer.indexOf("\n")
      if (newline === -1) return
      const line = buffer.slice(0, newline)
      buffer = buffer.slice(newline + 1)
      const request = JSON.parse(line) as BridgeRequest
      const result = await handler(request)
      if (request.id !== undefined) {
        socket.write(JSON.stringify({
          id: request.id,
          ok: true,
          result,
        }) + "\n")
      }
    })
  })

  if (process.platform !== "win32") {
    mkdirSync(dirname(socketPath), { recursive: true })
    rmSync(socketPath, { force: true })
  }

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(socketPath, () => {
      server.off("error", reject)
      resolve()
    })
  })

  try {
    await fn()
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    if (process.platform !== "win32") {
      rmSync(socketPath, { force: true })
    }
  }
}

async function runTsScript(
  scriptPath: string,
  args: string[],
  options?: {
    cwd?: string
    env?: Record<string, string | undefined>
  }
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const env = {
    ...process.env,
    ...(options?.env ?? {}),
  }

  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete env[key]
  }

  const proc = Bun.spawn({
    cmd: [process.execPath, scriptPath, ...args],
    cwd: options?.cwd ?? repoRoot,
    env,
    stdout: "pipe",
    stderr: "pipe",
  })

  const stdout = await new Response(proc.stdout).text()
  const stderr = await new Response(proc.stderr).text()
  const exitCode = await proc.exited
  return { exitCode, stdout, stderr }
}

describe("lectic editor plugin", () => {
  test("builds a parent nvim checktime command from NVIM", () => {
    expect(parentNvimChecktimeCommand({ NVIM: "/tmp/nvim.sock" })).toEqual([
      "nvim",
      "--server",
      "/tmp/nvim.sock",
      "--remote-expr",
      "luaeval('vim.schedule(function() pcall(vim.cmd, [[checktime]]) end)')",
    ])
  })

  test("skips parent nvim checktime when NVIM is not set", async () => {
    const calls: string[][] = []
    const changed = await maybeChecktimeParentNvim({}, async (argv) => {
      calls.push(argv)
    })

    expect(changed).toBe(false)
    expect(calls).toEqual([])
  })

  test("runs parent nvim checktime when NVIM is set", async () => {
    const calls: string[][] = []
    const changed = await maybeChecktimeParentNvim(
      { NVIM: "/tmp/nvim.sock" },
      async (argv) => {
        calls.push(argv)
      }
    )

    expect(changed).toBe(true)
    expect(calls).toEqual([
      [
        "nvim",
        "--server",
        "/tmp/nvim.sock",
        "--remote-expr",
        "luaeval('vim.schedule(function() pcall(vim.cmd, [[checktime]]) end)')",
      ],
    ])
  })

  test("pick discovers the bridge by walking upward from cwd", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "lectic-editor-plugin-state-"))
    const workspaceRoot = mkdtempSync(join(tmpdir(), "lectic-editor-plugin-root-"))
    const nestedDir = join(workspaceRoot, "a", "b")
    mkdirSync(nestedDir, { recursive: true })

    const socketPath = editorBridgeSocketPath(workspaceRoot, stateDir)

    try {
      await withFakeBridge(socketPath, async (request) => {
        expect(request.type).toBe("query.pick")
        expect(request.params?.title).toBe("Choose target")
        expect(request.params?.options).toEqual(["staging", "prod"])
        return { choice: "prod" }
      }, async () => {
        const result = await runTsScript(editorScriptPath, [
          "pick",
          "--title",
          "Choose target",
          "--option",
          "staging",
          "--option",
          "prod",
        ], {
          cwd: nestedDir,
          env: {
            LECTIC_STATE: stateDir,
          },
        })

        expect(result.exitCode).toBe(0)
        expect(result.stderr).toBe("")
        expect(result.stdout.trim()).toBe("prod")
      })
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true })
      rmSync(stateDir, { recursive: true, force: true })
    }
  })

  test("truncates progress messages when requested", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "lectic-editor-plugin-state-"))
    const workspaceRoot = mkdtempSync(join(tmpdir(), "lectic-editor-plugin-root-"))
    const socketPath = editorBridgeSocketPath(workspaceRoot, stateDir)

    try {
      await withFakeBridge(socketPath, async (request) => {
        expect(request.type).toBe("progress.begin")
        expect(request.params).toEqual({
          token: "tok-1",
          title: "Running shell",
          message: "123456789…",
          percentage: undefined,
        })
        return undefined
      }, async () => {
        const result = await runTsScript(editorScriptPath, [
          "progress",
          "begin",
          "--token",
          "tok-1",
          "--title",
          "Running shell",
          "--message",
          "1234567890abcdef",
          "--message-max-length",
          "10",
        ], {
          cwd: workspaceRoot,
          env: {
            LECTIC_STATE: stateDir,
          },
        })

        expect(result.exitCode).toBe(0)
        expect(result.stdout).toBe("")
        expect(result.stderr).toBe("")
      })
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true })
      rmSync(stateDir, { recursive: true, force: true })
    }
  })

  test("tool progress hook script formats argv for progress", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "lectic-editor-plugin-state-"))
    const workspaceRoot = mkdtempSync(join(tmpdir(), "lectic-editor-plugin-root-"))
    const socketPath = editorBridgeSocketPath(workspaceRoot, stateDir)

    try {
      await withFakeBridge(socketPath, async (request) => {
        expect(request.type).toBe("progress.begin")
        expect(request.params).toEqual({
          token: "call-1",
          title: "Running shell",
          message: "git diff --cached --stat",
        })
        return undefined
      }, async () => {
        const result = await runTsScript(toolProgressStartPath, [], {
          cwd: workspaceRoot,
          env: {
            LECTIC_STATE: stateDir,
            TOOL_CALL_ID: "call-1",
            TOOL_NAME: "shell",
            TOOL_ARGS: JSON.stringify({
              argv: ["git", "diff", "--cached", "--stat"],
            }),
          },
        })

        expect(result.exitCode).toBe(0)
        expect(result.stdout).toBe("")
        expect(result.stderr).toBe("")
      })
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true })
      rmSync(stateDir, { recursive: true, force: true })
    }
  })

  test("tool approval hook script sends a formatted approval prompt", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "lectic-editor-plugin-state-"))
    const workspaceRoot = mkdtempSync(join(tmpdir(), "lectic-editor-plugin-root-"))
    const socketPath = editorBridgeSocketPath(workspaceRoot, stateDir)

    try {
      await withFakeBridge(socketPath, async (request) => {
        expect(request.type).toBe("query.confirm")
        expect(request.params).toEqual({
          title: "Allow shell?",
          message: "Tool: shell\n\nArguments:\ngit diff --cached",
          allow: "Allow",
          deny: "Deny",
          severity: "warning",
        })
        return { approved: false }
      }, async () => {
        const result = await runTsScript(toolApprovePath, [], {
          cwd: workspaceRoot,
          env: {
            LECTIC_STATE: stateDir,
            TOOL_NAME: "shell",
            TOOL_ARGS: JSON.stringify({
              argv: ["git", "diff", "--cached"],
            }),
          },
        })

        expect(result.exitCode).toBe(1)
        expect(result.stdout).toBe("")
        expect(result.stderr).toBe("")
      })
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true })
      rmSync(stateDir, { recursive: true, force: true })
    }
  })

  test("approve exits non-zero when the editor denies the request", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "lectic-editor-plugin-state-"))
    const workspaceRoot = mkdtempSync(join(tmpdir(), "lectic-editor-plugin-root-"))
    const socketPath = editorBridgeSocketPath(workspaceRoot, stateDir)

    try {
      await withFakeBridge(socketPath, async (request) => {
        expect(request.type).toBe("query.confirm")
        return { approved: false }
      }, async () => {
        const result = await runTsScript(editorScriptPath, [
          "approve",
          "--title",
          "Allow tool use?",
          "--message",
          "Tool: shell",
        ], {
          cwd: workspaceRoot,
          env: {
            LECTIC_STATE: stateDir,
          },
        })

        expect(result.exitCode).toBe(1)
        expect(result.stdout).toBe("")
        expect(result.stderr).toBe("")
      })
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true })
      rmSync(stateDir, { recursive: true, force: true })
    }
  })
})
