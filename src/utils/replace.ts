import { lecticEnv } from "../utils/xdg";

export function simultaneousReplace(expansionMap : { [key: string] : string }, target : string) {
    const regex = RegExp(Object.keys(expansionMap).map(RegExp.escape).join('|'),"g")
    return target.replaceAll(regex, match => expansionMap[match] ?? match)
}

export function expandEnv(target : string) : string {
    const env : {[key: string] : string | undefined } = { ...process.env, ...lecticEnv }
    const newEnv : {[key: string] : string } = {}
    for (const key of Object.keys(env)) {
        if (env[key]) newEnv[`$${key}`] = env[key]
    }
    return simultaneousReplace(newEnv, target)
}
