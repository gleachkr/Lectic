export function simultaneousReplace(expansionMap : { [key: string] : string }, target : string) {
    const regex = RegExp(Object.keys(expansionMap).map(RegExp.escape).join('|'),"g")
    return target.replaceAll(regex, match => expansionMap[match] ?? match)
}
