import * as fs from "fs";
import { lecticEnv } from "../utils/xdg";

function execScript(script : string) {
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
            env: { ...process.env, ...lecticEnv }
        })
    cleanup()
    return proc.stdout.toString();
}

function execCmd(cmd: string) {
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
        env: { ...process.env, ...lecticEnv }
    });
    return proc.stdout.toString();
}

export async function loadFrom<T>(something: T): Promise<T | string> {
    if (typeof something === "string") {
        if (something.slice(0, 5) === "file:") {
            const path = something.slice(5).trim();
            if (!path) {
                throw new Error("File path cannot be empty.");
            }
            return await Bun.file(path).text();
        } else if (something.slice(0, 5) === "exec:") {
            const command = something.slice(5).trim();
            if (!command) {
                throw new Error("Exec command cannot be empty.");
            }
            return command.split("\n").length > 1 
                ? execScript(command)
                : execCmd(command)
        } else {
            return something;
        }
    }
    return something;
}
