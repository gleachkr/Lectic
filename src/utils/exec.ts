import * as fs from "fs";
import { lecticEnv } from "../utils/xdg";

export function execScript(script : string, env: Record<string, string | undefined> = {}) {
    if (script.slice(0,2) !== "#!") {
        throw Error("Expected shebang in first line of executable script")
    }
    const shebangArgs = script.slice(2).split('\n')[0].trim().split(' ')
    const tmpName = `./.lectic_script-${Bun.randomUUIDv7()}`
    const cleanup = () => fs.existsSync(tmpName) && fs.unlinkSync(tmpName)
    process.on('exit', cleanup)
    Bun.write(tmpName, script)
    const proc = Bun.spawnSync([
        ...shebangArgs, 
        tmpName], { 
            stderr: "ignore",
            env: { ...process.env, ...lecticEnv, ...env }
        })
    cleanup()
    return proc.stdout.toString();
}

export function execCmd(cmd: string, env: Record<string, string | undefined> = {}) {
    const args = cmd
        // break into whitespace-delimited pieces, allowing for quotes
        .match(/"[^"]*"|'[^']*'|\S+/g)
        // remove surrounding quotes from pieces
        ?.map(arg => (arg.startsWith('"') && arg.endsWith('"'))
            || (arg.startsWith("'") && arg.endsWith("'"))
            ? arg.slice(1, -1)
            : arg
        );
    const proc = Bun.spawnSync(args ?? [], {
        stderr: "ignore",
        env: { ...process.env, ...lecticEnv, ...env }
    });
    return proc.stdout.toString();
}
