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
            const args = command
                // break into whitespace-delimited pieces, allowing for quotes
                .match(/"[^"]*"|'[^']*'|\S+/g)
                // remove surrounding quotes from pieces
                ?.map(arg => (arg.startsWith('"') && arg.endsWith('"'))
                    || (arg.startsWith("'") && arg.endsWith("'"))
                    ? arg.slice(1, -1)
                    : arg
                );
            const proc = Bun.spawnSync(args ?? [], {
                stderr: "ignore"
            });
            return proc.stdout.toString();
        } else {
            return something;
        }
    }
    return something;
}
