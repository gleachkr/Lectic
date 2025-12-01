import { lecticEnv } from "../utils/xdg";
import { parseCommandToArgv, writeTempShebangScriptSync } from "./execHelpers";

export function execScriptFull(script : string, env: Record<string, string | undefined> = {}, stdin? : Blob) {
    const { path, shebangArgs, cleanup } = writeTempShebangScriptSync(script)
    const proc = Bun.spawnSync([
        ...shebangArgs,
        path
    ], {
        stdin,
        stderr: "ignore",
        env: { ...process.env, ...lecticEnv, ...env }
    })
    cleanup()
    return { stdout: proc.stdout.toString(), exitCode: proc.exitCode };
}

export function execCmdFull(cmd: string, env: Record<string, string | undefined> = {}, stdin? : Blob) {
    const args = parseCommandToArgv(cmd)
    const proc = Bun.spawnSync(args, {
        stdin,
        stderr: "ignore",
        env: { ...process.env, ...lecticEnv, ...env }
    });
    return { stdout: proc.stdout.toString(), exitCode: proc.exitCode };
}

export function execScript(script : string, env: Record<string, string | undefined> = {}, stdin? : Blob) {
    return execScriptFull(script, env, stdin).stdout
}

export function execCmd(cmd: string, env: Record<string, string | undefined> = {}, stdin? : Blob) {
    return execCmdFull(cmd, env, stdin).stdout
}
