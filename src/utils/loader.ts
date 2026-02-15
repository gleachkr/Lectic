import { expandEnv } from "./replace";
import { execScript, execCmd} from "./exec";

export function isLoadableSource(value: string): boolean {
    const trimmed = value.trimStart();
    return trimmed.startsWith("file:") || trimmed.startsWith("exec:");
}

export async function loadFrom<T>(something: T, env: Record<string, string | undefined> = {}): Promise<T | string> {
    if (typeof something === "string") {
        if (something.slice(0, 5) === "file:") {
            // We expaned $VARIABLE names in paths and commands
            const path = expandEnv(something.slice(5).trim());
            if (!path) {
                throw new Error("File path cannot be empty.");
            }
            return Bun.file(path).text();
        } else if (something.slice(0, 5) === "exec:") {
            const command = something.slice(5).trim();
            if (!command) {
                throw new Error("Exec command cannot be empty.");
            }
            return command.split("\n").length > 1 
                ? execScript(command, env)
                : execCmd(expandEnv(command, env), env)
        } else {
            return something;
        }
    }
    return something;
}
