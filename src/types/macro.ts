import { loadFrom } from "../utils/loader"

export type MacroSpec = {
    name: string
    expansion: string
}

export function validateMacroSpec (raw : unknown) : raw is MacroSpec {
    if (typeof raw !== "object") {
        throw Error(`Macro needs to be given with at least "name" and "expansion" fields. Got ${raw} instead.`)
    }
    if (raw === null) {
        throw Error("Something went wrong, got null for macro")
    }
    if (!("name" in raw) || (typeof raw.name !== "string")) {
        throw Error(`Macro needs to be given with a "name" field.`)
    }
    if (!("expansion" in raw) || (typeof raw.expansion !== "string")) {
        throw Error(`Macro needs to be given with an "expansion" field.`)
    }
    return true
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
