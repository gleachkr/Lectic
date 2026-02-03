import { describe, it, expect, beforeEach, afterAll } from "bun:test"
import { mkdirSync, writeFileSync, rmSync } from "fs"
import { join, resolve } from "path"
import { tmpdir } from "os"

import { Logger } from "./logging/logger"
import { scriptCmd } from "./scriptCmd"

const originalWrite = Logger.write
let logs: string[] = []
Logger.write = async (msg: string | any) => {
    logs.push(typeof msg === "string" ? msg : JSON.stringify(msg))
}

async function withCwd<T>(cwd: string, fn: () => Promise<T>): Promise<T> {
    const old = process.cwd()
    process.chdir(cwd)
    try {
        return await fn()
    } finally {
        process.chdir(old)
    }
}

function withCapturedConsole<T>(
    fn: () => Promise<T>
): Promise<{ out: string[], value: T }> {
    const out: string[] = []
    const originalLog = console.log

    console.log = (...args: unknown[]) => {
        out.push(args.map((a) => String(a)).join(" "))
    }

    return fn()
        .then((value) => ({ out, value }))
        .finally(() => {
            console.log = originalLog
        })
}

async function runInChild(cwd: string, argv: string[]): Promise<{
    exitCode: number
    stdout: string
    stderr: string
}> {
    const runnerPath = join(cwd, "runner.ts")
    const scriptCmdPath = resolve(import.meta.dir, "scriptCmd.ts")

    writeFileSync(
        runnerPath,
        `import { scriptCmd } from ${JSON.stringify(scriptCmdPath)}\n`
        + `const code = await scriptCmd(process.argv.slice(2))\n`
        + `process.exit(code)\n`
    )

    const proc = Bun.spawn({
        cmd: [process.argv[0] || "bun", runnerPath, ...argv],
        cwd,
        env: process.env,
        stdout: "pipe",
        stderr: "pipe",
    })

    const stdout = await new Response(proc.stdout).text()
    const stderr = await new Response(proc.stderr).text()
    const exitCode = await proc.exited

    return { exitCode, stdout, stderr }
}

describe("scriptCmd", () => {
    const dir = join(tmpdir(), `lectic-script-tests-${Date.now()}`)
    const originalCache = process.env["LECTIC_CACHE"]

    beforeEach(() => {
        logs = []
        rmSync(dir, { recursive: true, force: true })
        mkdirSync(dir, { recursive: true })
        process.env["LECTIC_CACHE"] = join(dir, "cache")
    })

    afterAll(() => {
        Logger.write = originalWrite

        if (originalCache === undefined) {
            delete process.env["LECTIC_CACHE"]
        } else {
            process.env["LECTIC_CACHE"] = originalCache
        }

        rmSync(dir, { recursive: true, force: true })
    })

    it("imports module by relative path and calls default()", async () => {
        writeFileSync(
            join(dir, "hello.mjs"),
            "export default function () { globalThis.__ran = true }\n"
        )

        await withCwd(dir, async () => {
            const code = await scriptCmd(["./hello.mjs"])
            expect(code).toBe(0)
            expect((globalThis as any).__ran).toBe(true)
        })

        delete (globalThis as any).__ran
    })

    it("sets process.argv for the script", async () => {
        writeFileSync(
            join(dir, "argv.mjs"),
            "export default () => { globalThis.__argv = process.argv }\n"
        )

        await withCwd(dir, async () => {
            const code = await scriptCmd(["./argv.mjs", "a", "b"])
            expect(code).toBe(0)

            const argv = (globalThis as any).__argv as string[]
            expect(argv[1]).toMatch(/argv\.mjs$/)
            expect(argv.slice(2)).toEqual(["a", "b"])
        })

        delete (globalThis as any).__argv
    })

    it("errors when module cannot be read", async () => {
        await withCwd(dir, async () => {
            const code = await scriptCmd(["./missing.mjs"])
            expect(code).toBe(1)
            expect(logs.join("\n")).toContain("failed to read script")
        })
    })

    it("supports HTTP imports and caches the bundle", async () => {
        let hits = 0
        const server = Bun.serve({
            port: 0,
            fetch(req) {
                hits++
                const url = new URL(req.url)
                if (url.pathname === "/dep.ts") {
                    return new Response("export const n = 41\n")
                }
                return new Response(
                    "import { n } from './dep.ts'\n"
                    + "export const answer = n + 1\n"
                )
            },
        })

        const entryUrl = `http://127.0.0.1:${server.port}/mod.ts`

        writeFileSync(
            join(dir, "remote.ts"),
            `import { answer } from ${JSON.stringify(entryUrl)}\n`
            + "console.log(answer)\n"
        )

        try {
            const first = await runInChild(dir, ["./remote.ts"])
            expect(first.exitCode).toBe(0)
            expect(first.stderr).toBe("")
            expect(first.stdout.trim()).toBe("42")

            const second = await runInChild(dir, ["./remote.ts"])
            expect(second.exitCode).toBe(0)
            expect(second.stderr).toBe("")
            expect(second.stdout.trim()).toBe("42")

            // 2 hits for the first run (mod.ts + dep.ts). Second run is cached.
            expect(hits).toBe(2)
        } finally {
            await server.stop()
        }
    })

    it("supports remote WASM assets when explicitly imported", async () => {
        let hits = 0
        const wasmBytes = new Uint8Array([
            0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
        ])

        const server = Bun.serve({
            port: 0,
            fetch(req) {
                hits++
                const url = new URL(req.url)
                if (url.pathname === "/x.wasm") {
                    return new Response(wasmBytes, {
                        headers: { "content-type": "application/wasm" },
                    })
                }
                if (url.pathname === "/mod.ts") {
                    return new Response(
                        "import './x.wasm'\n"
                        + "export default () => {\n"
                        + "  const u = import.meta.resolve('./x.wasm')\n"
                        + "  if (!u.includes('x.wasm')) throw new Error('bad')\n"
                        + "  console.log('ok')\n"
                        + "}\n"
                    )
                }
                return new Response("not found\n", { status: 404 })
            },
        })

        const entryUrl = `http://127.0.0.1:${server.port}/mod.ts`

        writeFileSync(
            join(dir, "remote-wasm.ts"),
            `import main from ${JSON.stringify(entryUrl)}\n`
            + "main()\n"
        )

        try {
            const first = await runInChild(dir, ["./remote-wasm.ts"])
            expect(first.exitCode).toBe(0)
            expect(first.stderr).toBe("")
            expect(first.stdout.trim()).toBe("ok")

            const second = await runInChild(dir, ["./remote-wasm.ts"])
            expect(second.exitCode).toBe(0)
            expect(second.stderr).toBe("")
            expect(second.stdout.trim()).toBe("ok")

            // 2 hits for the first run (mod.ts + x.wasm). Second run is cached.
            expect(hits).toBe(2)
        } finally {
            await server.stop()
        }
    })

    it("transpiles TSX with React imported from a URL", async () => {
        writeFileSync(
            join(dir, "tsconfig.json"),
            JSON.stringify({ compilerOptions: { jsx: "react-jsx" } })
        )

        const runtimeRequests: string[] = []

        const server = Bun.serve({
            port: 0,
            fetch(req) {
                const url = new URL(req.url)

                if (url.pathname === "/react") {
                    return new Response("export default {}\n")
                }

                if (
                    url.pathname === "/react/jsx-dev-runtime"
                    || url.pathname === "/react/jsx-runtime"
                ) {
                    runtimeRequests.push(url.search)
                    return new Response(
                        "export const Fragment = Symbol.for(\"react.fragment\")\n"
                        + "export function jsxDEV(type, props) {\n"
                        + "  const p = props || {}\n"
                        + "  const c = p.children\n"
                        + "  const children = Array.isArray(c)\n"
                        + "    ? c\n"
                        + "    : c === undefined\n"
                        + "      ? []\n"
                        + "      : [c]\n"
                        + "  return { type, props: p, children }\n"
                        + "}\n"
                        + "export const jsx = jsxDEV\n"
                        + "export const jsxs = jsxDEV\n"
                    )
                }

                return new Response("not found\n", { status: 404 })
            },
        })

        const reactUrl = `http://127.0.0.1:${server.port}/react?x=1`

        writeFileSync(
            join(dir, "tsx.tsx"),
            `import React from ${JSON.stringify(reactUrl)}\n`
            + "const el = <div id=\"x\" />\n"
            + "console.log(el.type)\n"
        )

        try {
            await withCwd(dir, async () => {
                const { out, value } = await withCapturedConsole(() =>
                    scriptCmd(["./tsx.tsx"])
                )
                expect(value).toBe(0)
                expect(out).toEqual(["div"])
            })

            // Ensure the runtime import kept the query string.
            expect(runtimeRequests.length).toBeGreaterThan(0)
            expect(runtimeRequests.every((s) => s === "?x=1")).toBe(true)
        } finally {
            await server.stop()
        }
    })

    it("requires a React URL import for TSX automatic runtime", async () => {
        writeFileSync(
            join(dir, "tsconfig.json"),
            JSON.stringify({ compilerOptions: { jsx: "react-jsx" } })
        )

        writeFileSync(
            join(dir, "local-react.tsx"),
            "import React from 'react'\n"
            + "const el = <div />\n"
            + "console.log(el.type)\n"
        )

        await withCwd(dir, async () => {
            const code = await scriptCmd(["./local-react.tsx"])
            expect(code).toBe(1)
            expect(logs.join("\n")).toContain("react/jsx")
        })
    })
})
