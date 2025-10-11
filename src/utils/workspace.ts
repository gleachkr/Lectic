import { join, dirname } from "path"

export async function readWorkspaceConfig(startDir: string): Promise<string | null> {
        let dir = startDir
        while (true) {
            try {
                return await Bun.file(join(dir, "lectic.yaml")).text()
            } catch {
                // move up; stop at filesystem root
                const parent = dirname(dir)
                if (parent === dir) return null
                dir = parent
            }
        }
}

