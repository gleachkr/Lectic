import * as fs from "fs";
import { lecticEnv } from "../utils/xdg";
import { expandEnv} from "./replace";

function execScript(script : string, env: { [key: string] : string} = {}) {
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

function execCmd(cmd: string, env: { [key: string] : string} = {}) {
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

export async function loadFrom<T>(something: T, env: { [key: string] : string} = {}): Promise<T | string> {
    if (typeof something === "string") {
        if (something.slice(0, 5) === "file:") {
            // We expaned $VARIABLE names in paths and commands
            const path = expandEnv(something.slice(5).trim());
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
                ? execScript(command, env)
                : execCmd(expandEnv(command), env)
        } else {
            return something;
        }
    }
    return something;
}
