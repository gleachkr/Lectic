// This recursively merges two values, applying `apply` to `base`, subject to
// the convention that if two elements of a list are objects with the same
// 'name' attribute, they're merged. Otherwise lists are concatinated. This
// fits with the lectic conventin of using a 'name' attribute for tools and
// interlocutors
export function mergeValues<A>(base : A, apply : A) : A
export function mergeValues(base : any, apply : any) : any {

    if (Array.isArray(base) && Array.isArray(apply)) {
        const baseObj : Record<string, any> = {}
        const applyObj : Record<string, any> = {}
        for (const item of base) {
            if (typeof item === 'object' && item !== null && "name" in item) {
                baseObj[item.name] = item
            } else {
                baseObj[Bun.randomUUIDv7()] = item
            }
        }
        for (const item of apply) {
            if (typeof item === 'object' && item !== null && "name" in item) {
                applyObj[item.name] = item
            } else {
                applyObj[Bun.randomUUIDv7()] = item
            }
        }
        return Object.values(mergeValues(baseObj, applyObj))
    }

    if (typeof base == "object" && base !== null &&
        typeof apply == "object" && apply !== null
       ) {
        const fresh : Record<string,any> = {}
        const keys = new Set([...Object.keys(base), ...Object.keys(apply)])
        for (const key of keys) {
            fresh[key] = mergeValues(base[key], apply[key])
        }
        return fresh
    }

    return apply ?? base
}
