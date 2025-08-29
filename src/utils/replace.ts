import { lecticEnv } from "../utils/xdg";

export function simultaneousReplace(expansionMap : Record<string, string>, target : string) {
    const regex = RegExp(Object.keys(expansionMap).map(RegExp.escape).join('|'),"g")
    return target.replaceAll(regex, match => expansionMap[match] ?? match)
}

export function expandEnv(target : string) : string {
    const env : Record<string, string | undefined> = { ...process.env, ...lecticEnv }
    const newEnv : Record<string, string> = {}
    for (const key of Object.keys(env)) {
        if (env[key]) newEnv[`$${key}`] = env[key]
    }
    return simultaneousReplace(newEnv, target)
}
