import { describe, it, expect, beforeEach, afterAll } from "bun:test"
import { mkdirSync, writeFileSync, rmSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"

import { Logger } from "./logging/logger"
import { scriptCmd } from "./scriptCmd"

const originalWrite = Logger.write
let logs: string[] = []
Logger.write = async (msg: string | any) => {
    logs.push(typeof msg === "string" ? msg : JSON.stringify(msg))
}

function withExitIntercept<T>(
    fn: () => Promise<T>
): Promise<{ code: number | null, value?: T }> {
    const origExit = process.exit
    let exitCode: number | null = null
    ;(process as any).exit = ((code?: number) => {
        exitCode = code ?? 0
        throw new Error("process.exit")
    }) as any

    return fn()
        .then((value) => ({ code: exitCode, value }))
        .catch((e) => {
            if (e instanceof Error && e.message === "process.exit") {
                return { code: exitCode }
            }
            throw e
        })
        .finally(() => {
            process.exit = origExit
        })
}

describe("scriptCmd", () => {
    const dir = join(tmpdir(), `lectic-script-tests-${Date.now()}`)

    beforeEach(() => {
        logs = []
        mkdirSync(dir, { recursive: true })
    })

    afterAll(() => {
        Logger.write = originalWrite
        rmSync(dir, { recursive: true, force: true })
    })

    it("imports module by relative path and calls default()", async () => {
        const scriptPath = join(dir, "hello.mjs")
        writeFileSync(
            scriptPath,
            "export default function () { globalThis.__ran = true }\n"
        )

        const cwd = process.cwd()
        process.chdir(dir)
        try {
            const { code } = await withExitIntercept(async () => {
                await scriptCmd(["./hello.mjs"])
            })

            expect(code).toBeNull()
            expect((globalThis as any).__ran).toBe(true)
        } finally {
            process.chdir(cwd)
            delete (globalThis as any).__ran
        }
    })

    it("sets process.argv for the script", async () => {
        const scriptPath = join(dir, "argv.mjs")
        writeFileSync(
            scriptPath,
            "export default function main() { globalThis.__argv = process.argv }\n"
        )

        const cwd = process.cwd()
        process.chdir(dir)
        try {
            await scriptCmd(["./argv.mjs", "a", "b"])

            const argv = (globalThis as any).__argv as string[]
            expect(argv[1]).toMatch(/argv\.mjs$/)
            expect(argv.slice(2)).toEqual(["a", "b"])
        } finally {
            process.chdir(cwd)
            delete (globalThis as any).__argv
        }
    })

    it("errors when module cannot be imported", async () => {
        const cwd = process.cwd()
        process.chdir(dir)
        try {
            const { code } = await withExitIntercept(async () => {
                await scriptCmd(["./missing.mjs"])
            })

            expect(code).toBe(1)
            expect(logs.join("\n")).toContain("failed to import")
        } finally {
            process.chdir(cwd)
        }
    })
})
