import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"

import { editorBridgeSocketPath } from "../../../src/lsp/editorBridge"

type BridgeRequest = {
  id?: string
  type?: string
  params?: Record<string, unknown>
}

const repoRoot = resolve(import.meta.dir, "..", "..", "..");
const editorScriptPath = resolve(import.meta.dir, "lectic-editor.ts");

async function withFakeBridge(
  socketPath: string,
  handler: (request: BridgeRequest) => unknown | Promise<unknown>,
  fn: () => Promise<void>
): Promise<void> {
  const requests: BridgeRequest[] = []
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
      requests.push(request)
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

  void requests
}

async function runEditor(
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
    cmd: [process.execPath, editorScriptPath, ...args],
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
        const result = await runEditor([
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

  test("approve exits non-zero when the editor denies the request", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "lectic-editor-plugin-state-"))
    const workspaceRoot = mkdtempSync(join(tmpdir(), "lectic-editor-plugin-root-"))
    const socketPath = editorBridgeSocketPath(workspaceRoot, stateDir)

    try {
      await withFakeBridge(socketPath, async (request) => {
        expect(request.type).toBe("query.confirm")
        return { approved: false }
      }, async () => {
        const result = await runEditor([
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
