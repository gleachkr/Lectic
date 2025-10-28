import { lecticEnv } from "../utils/xdg";
import { parseCommandToArgv, writeTempShebangScriptSync } from "./execHelpers";

export function execScript(script : string, env: Record<string, string | undefined> = {}) {
    const { path, shebangArgs, cleanup } = writeTempShebangScriptSync(script)
    const proc = Bun.spawnSync([
        ...shebangArgs,
        path
    ], {
        stderr: "ignore",
        env: { ...process.env, ...lecticEnv, ...env }
    })
    cleanup()
    return proc.stdout.toString();
}

export function execCmd(cmd: string, env: Record<string, string | undefined> = {}) {
    const args = parseCommandToArgv(cmd)
    const proc = Bun.spawnSync(args, {
        stderr: "ignore",
        env: { ...process.env, ...lecticEnv, ...env }
    });
    return proc.stdout.toString();
}
