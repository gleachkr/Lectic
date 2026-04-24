import { lecticEnv } from "../utils/xdg";
import {
    cleanupTempScriptAfterProcess,
    parseAndExpandCommand,
    writeTempShebangScriptSync,
} from "./execHelpers";

function mergedEnv(env: Record<string, string | undefined>) {
    return { ...process.env, ...lecticEnv, ...env }
}

export function execScriptFull(
    script : string,
    env: Record<string, string | undefined> = {},
    stdin? : Blob
) {
    const { path, shebangArgs, cleanup } = writeTempShebangScriptSync(script)

    try {
        const proc = Bun.spawnSync([
            ...shebangArgs,
            path
        ], {
            stdin,
            env: mergedEnv(env)
        })
        return {
            stdout: proc.stdout.toString(),
            stderr: proc.stderr.toString(),
            exitCode: proc.exitCode,
        }
    } finally {
        cleanup()
    }
}

export function execCmdFull(
    cmd: string,
    env: Record<string, string | undefined> = {},
    stdin? : Blob
) {
    const args = parseAndExpandCommand(cmd, env)
    const proc = Bun.spawnSync(args, {
        stdin,
        env: mergedEnv(env)
    })
    return {
        stdout: proc.stdout.toString(),
        stderr: proc.stderr.toString(),
        exitCode: proc.exitCode,
    }
}

export function execScript(
    script : string,
    env: Record<string, string | undefined> = {},
    stdin? : Blob
) {
    return execScriptFull(script, env, stdin).stdout
}

export function execCmd(
    cmd: string,
    env: Record<string, string | undefined> = {},
    stdin? : Blob
) {
    return execCmdFull(cmd, env, stdin).stdout
}

export function execScriptBackground(
    script: string,
    env: Record<string, string | undefined> = {},
    stdin?: Blob
): Promise<number> {
    const { path, shebangArgs, cleanup } = writeTempShebangScriptSync(script)

    try {
        const proc = Bun.spawn([
            ...shebangArgs,
            path,
        ], {
            stdin,
            stdout: "ignore",
            stderr: "ignore",
            env: mergedEnv(env),
        })
        return cleanupTempScriptAfterProcess(proc, cleanup)
    } catch (error) {
        cleanup()
        throw error
    }
}

export function execCmdBackground(
    cmd: string,
    env: Record<string, string | undefined> = {},
    stdin?: Blob
): Promise<number> {
    const args = parseAndExpandCommand(cmd, env)
    const proc = Bun.spawn(args, {
        stdin,
        stdout: "ignore",
        stderr: "ignore",
        env: mergedEnv(env),
    })
    return proc.exited
}

export function execScriptDetached(
    script: string,
    env: Record<string, string | undefined> = {},
    stdin?: Blob
): Promise<number> {
    const { path, shebangArgs } = writeTempShebangScriptSync(script)

    const proc = Bun.spawn([
        ...shebangArgs,
        path,
    ], {
        stdin,
        stdout: "ignore",
        stderr: "ignore",
        detached: true,
        env: mergedEnv(env),
    })
    proc.unref()
    return proc.exited
}

export function execCmdDetached(
    cmd: string,
    env: Record<string, string | undefined> = {},
    stdin?: Blob
): Promise<number> {
    const args = parseAndExpandCommand(cmd, env)
    const proc = Bun.spawn(args, {
        stdin,
        stdout: "ignore",
        stderr: "ignore",
        detached: true,
        env: mergedEnv(env),
    })
    proc.unref()
    return proc.exited
}
