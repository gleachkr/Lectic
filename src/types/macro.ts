import { loadFrom } from "../utils/loader"

export type MacroSpec = {
    name: string
    expansion: string
}

export function isMacroSpec (raw : unknown) : raw is MacroSpec {
    return typeof raw == "object" &&
        raw !== null &&
        'name' in raw &&
        typeof raw.name === "string" &&
        'expansion' in raw &&
        typeof raw.expansion === "string"
}

export class Macro {
    name : string
    expansion : string
    constructor({name, expansion} : MacroSpec) {
        this.name = name
        this.expansion = expansion
    }

    async expand(env : Record<string, string | undefined> = {}) : Promise<string> {
        return loadFrom(this.expansion, env)
    }
}
