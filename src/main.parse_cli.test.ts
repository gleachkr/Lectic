import { describe, it, expect, afterAll } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join, resolve } from 'path'
import { tmpdir } from 'os'

type CliResult = {
    exitCode: number
    stdout: string
    stderr: string
}

async function runMain(argv: string[]): Promise<CliResult> {
    const mainPath = resolve(import.meta.dir, 'main.ts')
    const proc = Bun.spawn({
        cmd: [process.execPath, mainPath, ...argv],
        cwd: process.cwd(),
        env: process.env,
        stdout: 'pipe',
        stderr: 'pipe',
    })

    const stdout = await new Response(proc.stdout).text()
    const stderr = await new Response(proc.stderr).text()
    const exitCode = await proc.exited

    return { exitCode, stdout, stderr }
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
