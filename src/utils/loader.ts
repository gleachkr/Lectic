export async function loadFrom<T>(something: T): Promise<T | string> {
    if (typeof something === "string") {
        if (something.slice(0, 5) === "file:") {
            return await Bun.file(something.slice(5).trim()).text();
        } else if (something.slice(0, 5) === "exec:") {
            const args = something.slice(5)
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
