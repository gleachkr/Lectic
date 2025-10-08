import { loadFrom } from "../utils/loader"
import { Messages } from "../constants/messages"

export type MacroSpec = {
    name: string
    expansion: string
}

export function validateMacroSpec (raw : unknown) : raw is MacroSpec {
    if (typeof raw !== "object") {
        throw Error(Messages.macro.baseNeedsNameExpansion(raw))
    }
    if (raw === null) {
        throw Error(Messages.macro.baseNull())
    }
    if (!("name" in raw) || (typeof raw.name !== "string")) {
        throw Error(Messages.macro.nameMissing())
    }
    if (!("expansion" in raw) || (typeof raw.expansion !== "string")) {
        throw Error(Messages.macro.expansionMissing())
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
