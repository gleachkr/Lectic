import { lecticEnv } from "../utils/xdg";
import { parseCommandToArgv, writeTempShebangScriptSync } from "./execHelpers";

function mergedEnv(env: Record<string, string | undefined>) {
    return { ...process.env, ...lecticEnv, ...env }
}

export function execScriptFull(script : string, env: Record<string, string | undefined> = {}, stdin? : Blob) {
    const { path, shebangArgs, cleanup } = writeTempShebangScriptSync(script)
    const proc = Bun.spawnSync([
        ...shebangArgs,
        path
    ], {
        stdin,
        env: mergedEnv(env)
    })
    cleanup()
    return {
        stdout: proc.stdout.toString(),
        stderr: proc.stderr.toString(),
        exitCode: proc.exitCode,
    }
}

export function execCmdFull(cmd: string, env: Record<string, string | undefined> = {}, stdin? : Blob) {
    const args = parseCommandToArgv(cmd)
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

export function execScript(script : string, env: Record<string, string | undefined> = {}, stdin? : Blob) {
    return execScriptFull(script, env, stdin).stdout
}

export function execCmd(cmd: string, env: Record<string, string | undefined> = {}, stdin? : Blob) {
    return execCmdFull(cmd, env, stdin).stdout
}

export function execScriptDetached(
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
            detached: true,
            env: mergedEnv(env),
        })
        return proc.exited.finally(cleanup)
    } catch (error) {
        cleanup()
        throw error
    }
}

export function execCmdDetached(
    cmd: string,
    env: Record<string, string | undefined> = {},
    stdin?: Blob
): Promise<number> {
    const args = parseCommandToArgv(cmd)
    const proc = Bun.spawn(args, {
        stdin,
        stdout: "ignore",
        stderr: "ignore",
        detached: true,
        env: mergedEnv(env),
    })
    return proc.exited
}
