import { describe, it, expect, afterAll } from 'bun:test'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { createServer, type Server } from 'http'
import { tmpdir } from 'os'
import { join, resolve } from 'path'

import { version } from '../package.json'

type CliResult = {
    exitCode: number
    stdout: string
    stderr: string
}

async function runMain(
    argv: string[],
    env: Record<string, string> = {}
): Promise<CliResult> {
    const mainPath = resolve(import.meta.dir, 'main.ts')
    const proc = Bun.spawn({
        cmd: [process.execPath, mainPath, ...argv],
        cwd: process.cwd(),
        env: {
            ...process.env,
            LECTIC_CONFIG: "not-a-directory",
            ...env,
        },
        stdout: 'pipe',
        stderr: 'pipe',
    })

    const stdout = await new Response(proc.stdout).text()
    const stderr = await new Response(proc.stderr).text()
    const exitCode = await proc.exited

    return { exitCode, stdout, stderr }
}

async function waitForExists(path: string, timeoutMs = 1000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs

    while (Date.now() < deadline) {
        if (existsSync(path)) return true
        await Bun.sleep(25)
    }

    return existsSync(path)
}

async function waitFor<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
    return Promise.race([
        promise,
        Bun.sleep(timeoutMs).then(() => {
            throw new Error(`timed out after ${timeoutMs} ms`)
        }),
    ])
}

async function tryListen(server: Server, port: number): Promise<boolean> {
    return new Promise((resolve, reject) => {
        server.once('error', (error: NodeJS.ErrnoException) => {
            if (error.code === 'EADDRINUSE') {
                resolve(false)
                return
            }
            reject(error)
        })
        server.listen(port, '127.0.0.1', () => {
            server.removeAllListeners('error')
            resolve(true)
        })
    })
}

async function closeServer(server: Server): Promise<void> {
    if (!server.listening) return
    await new Promise<void>((resolve) => server.close(() => resolve()))
}

describe('main parse command CLI', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lectic-main-parse-'))

    afterAll(() => {
        rmSync(dir, { recursive: true, force: true })
    })

    it('accepts "lectic parse -f <file>"', async () => {
        const file = join(dir, 'conversation.lec')
        writeFileSync(
            file,
            [
                '---',
                'interlocutor:',
                '  name: Assistant',
                '  prompt: hi',
                '---',
                '',
                'hello',
                '',
            ].join('\n')
        )

        const result = await runMain(['parse', '-f', file])

        expect(result.exitCode).toBe(0)
        expect(result.stderr).toBe('')
        expect(result.stdout).toContain('"messages"')
    })
})

describe('main generate CLI flags', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lectic-main-generate-'))

    afterAll(() => {
        rmSync(dir, { recursive: true, force: true })
    })

    it('accepts "lectic -i -f <file>"', async () => {
        const file = join(dir, 'conversation.lec')
        writeFileSync(file, 'hello\n')

        const result = await runMain(['-i', '-f', file, '--version'])

        expect(result.exitCode).toBe(0)
        expect(result.stderr).toBe('')
        expect(result.stdout).toBe(`${version}\n`)
    })

    it('accepts "lectic -if <file>"', async () => {
        const file = join(dir, 'conversation-short.lec')
        writeFileSync(file, 'hello\n')

        const result = await runMain(['-if', file, '--version'])

        expect(result.exitCode).toBe(0)
        expect(result.stderr).toBe('')
        expect(result.stdout).toBe(`${version}\n`)
    })

    it('rejects "lectic -i" without "-f"', async () => {
        const result = await runMain(['-i', '--version'])

        expect(result.exitCode).toBe(1)
        expect(result.stderr).toBe('')
        expect(result.stdout).toContain(
            "You can't use --inplace without --file"
        )
    })

    it('waits for background run_end hooks before exit', async () => {
        const hookOut = join(dir, 'run-end-hook.txt')
        const file = join(dir, 'run-end.lec')
        const cacheDir = join(dir, 'cache')
        const stateDir = join(dir, 'state')

        writeFileSync(
            file,
            [
                '---',
                'hooks:',
                '  - on: run_end',
                '    mode: background',
                '    allow_failure: true',
                '    env:',
                `      OUT: ${hookOut}`,
                '    do: |',
                '      #!/usr/bin/env bash',
                '      sleep 0.1',
                '      printf end > "$OUT"',
                'interlocutor:',
                '  name: Assistant',
                '  prompt: hi',
                '  provider: ollama',
                '  model: llama3.2',
                '---',
                '',
                'hello',
                '',
            ].join('\n')
        )

        const result = await runMain([
            '--format',
            'none',
            '-f',
            file,
        ], {
            LECTIC_CACHE: cacheDir,
            LECTIC_STATE: stateDir,
        })

        expect(result.exitCode).toBe(1)
        expect(await waitForExists(hookOut)).toBe(true)
        expect(await Bun.file(hookOut).text()).toBe('end')
    })

    it('runs run_end hooks before exiting on SIGINT', async () => {
        const hookOut = join(dir, 'run-end-sigint-hook.txt')
        const file = join(dir, 'run-end-sigint.lec')
        const cacheDir = join(dir, 'sigint-cache')
        const stateDir = join(dir, 'sigint-state')

        let sawRequest!: () => void
        const requestSeen = new Promise<void>((resolve) => {
            sawRequest = resolve
        })
        const server = createServer((req) => {
            if (req.url?.includes('/v1/chat/completions')) sawRequest()
        })
        const listening = await tryListen(server, 11434)
        if (!listening) return

        try {
            writeFileSync(
                file,
                [
                    '---',
                    'hooks:',
                    '  - on: run_end',
                    '    env:',
                    `      OUT: ${hookOut}`,
                    '    do: |',
                    '      #!/usr/bin/env bash',
                    '      printf "status=%s\\n" "$RUN_STATUS" > "$OUT"',
                    '      printf "error=%s\\n" "${RUN_ERROR_MESSAGE:-}" >> "$OUT"',
                    'interlocutor:',
                    '  name: Assistant',
                    '  prompt: hi',
                    '  provider: ollama',
                    '  model: llama3.2',
                    '---',
                    '',
                    'hello',
                    '',
                ].join('\n')
            )

            const mainPath = resolve(import.meta.dir, 'main.ts')
            const proc = Bun.spawn({
                cmd: [process.execPath, mainPath, '--format', 'none', '-f', file],
                cwd: process.cwd(),
                env: {
                    ...process.env,
                    LECTIC_CONFIG: 'not-a-directory',
                    LECTIC_CACHE: cacheDir,
                    LECTIC_STATE: stateDir,
                },
                stdout: 'pipe',
                stderr: 'pipe',
            })

            await waitFor(requestSeen, 3000)
            proc.kill('SIGINT')

            const stdout = await new Response(proc.stdout).text()
            const stderr = await new Response(proc.stderr).text()
            const exitCode = await waitFor(proc.exited, 3000)

            expect(exitCode).toBe(130)
            expect(stdout).toBe('')
            expect(stderr).toBe('')
            expect(await waitForExists(hookOut)).toBe(true)

            const hookText = await Bun.file(hookOut).text()
            expect(hookText).toContain('status=error\n')
            expect(hookText).toContain('error=Interrupted by SIGINT\n')
        } finally {
            await closeServer(server)
        }
    })
})
