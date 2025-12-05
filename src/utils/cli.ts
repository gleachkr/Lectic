import { join, dirname } from "path"
import { readWorkspaceConfig } from "./workspace";
import { lecticConfigDir, lecticEnv } from "./xdg";
import { type OptionValues } from 'commander'

export async function getLecticString(opts : OptionValues) : Promise<string> {
    if (opts["inplace"] || opts["file"]) {
        const path = opts["inplace"] || opts["file"]
        const fileText = await Bun.file(path).text()
        const pipeText = process.stdin.isTTY 
            ? "" 
            : `\n\n${await Bun.stdin.text()}` 
        return fileText + pipeText
    } else {
        return Bun.stdin.text()
    }
}


export async function getIncludes() : Promise<(string | null)[]> {
        const startDir = lecticEnv["LECTIC_FILE"] 
            ? dirname(lecticEnv["LECTIC_FILE"]) 
            : process.cwd()
        const workspaceConfig = await readWorkspaceConfig(startDir)
        const systemConfig = await Bun.file(join(lecticConfigDir(), 'lectic.yaml'))
            .text().catch(() => null)
        return [systemConfig, workspaceConfig]
}
