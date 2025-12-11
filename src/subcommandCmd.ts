import { lecticConfigDir, lecticDataDir, lecticEnv } from "./utils/xdg";
import { Logger } from "./logging/logger";

export async function tryRunSubcommand(command: string, args: string[]) {
    // Directories to search in order: Config, Data
    const searchDirs = [lecticConfigDir(), lecticDataDir()];
    
    // XXX: undefined searches PATH
    for (const dir of [...searchDirs, undefined]) {
        const cmdGlob = new Bun.Glob(`lectic-${command}{,.*}`)
        const matches = [... cmdGlob.scanSync({ cwd: dir })]
        if (matches.length > 1) {
            Logger.write(`multiple commands available: \n ${matches}\n`);
            break
        } 
        const pathExe = Bun.which(matches[0], { PATH : dir });
        if (pathExe) {
            await runExecutable(pathExe, args);
            return;
        }
    }

    // Not found
    Logger.write(`error: couldn't identify command '${command}'\n`);
    process.exit(1);
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
        Logger.write(`error: failed to execute subcommand '${path}': ${msg}\n`);
        process.exit(1);
    }
}
