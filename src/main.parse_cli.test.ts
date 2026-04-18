import { describe, it, expect, afterAll } from 'bun:test'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
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
})
