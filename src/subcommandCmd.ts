import { lecticConfigDir, lecticDataDir, lecticEnv } from "./utils/xdg";
import { Logger } from "./logging/logger";
import { delimiter } from "node:path"
import { existsSync, statSync, realpathSync, constants } from "node:fs"

export async function tryRunSubcommand(command: string, args: string[]) {
    // Directories to search in order: Config, Data, PATH
    const path = (process.env["PATH"] || "").split(delimiter)
    const searchDirs = [lecticConfigDir(), lecticDataDir(), ...path];
    
    for (const dir of searchDirs) {
        if (!existsSync(dir) || !statSync(dir).isDirectory()) continue
        const cmdGlob = new Bun.Glob(`lectic-${command}{,.*}`)
        const matches = [... cmdGlob.scanSync({ cwd: dir, onlyFiles: false })]
            // resolve symlinks
            .map(file => realpathSync(`${dir}/${file}`))
            // filter to executables
            .filter(file => statSync(file).mode & constants.S_IXUSR)
        if (matches.length > 1) {
            await Logger.write(`multiple commands available: \n ${matches}\n`)
            break
        } 
        if (matches.length < 1) continue
        await runExecutable(matches[0], args);
        return;
    }

    // Not found
    await Logger.write(`error: couldn't identify command '${command}'\n`)
    process.exit(1)
}

async function runExecutable(path: string, args: string[]) {
    const env = { ...process.env, ...lecticEnv };
    
    try {
        const proc = Bun.spawn([path, ...args], {
            env,
            stdio: ['inherit', 'inherit', 'inherit']
        });
        
        const exitCode = await proc.exited;
        process.exit(exitCode);
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        await Logger.write(
            `error: failed to execute subcommand '${path}': ${msg}\n`
        )
        process.exit(1)
    }
}
