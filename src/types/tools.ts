type SQLiteToolParams = {
    database: string
}

function isSQLiteToolParams(raw : unknown) : raw is SQLiteToolParams {
    return raw !== null &&
        typeof raw === "object" &&
        "database" in raw &&
        typeof raw.database === "string"
}

type ExecToolParams = {
    confirm: boolean,
}

function isExecToolParams(raw : unknown) : raw is ExecToolParams {
    return raw !== null &&
        typeof raw === "object" &&
        "confirm" in raw &&
        typeof raw.confirm=== "boolean"
}

export type ToolSpec = { Exec: ExecToolParams } 
                     | { SQLite: SQLiteToolParams }

export function isToolSpec(raw : unknown) : raw is ToolSpec {
    return raw !== null &&
        typeof raw === "object" &&
        ("Exec" in raw ? isExecToolParams(raw.Exec) : true) &&
        ("SQLite" in raw ? isSQLiteToolParams(raw.SQLite) : true)
}

type SchemaType = "object" | "number" | "string" | "integer" | "boolean" | "array" | "null"

type ToolParameter = {
    type: SchemaType,
    description: string
    enum? : any[] // An array of possible responses TODO can this be more precisely typed?
    minimum? : number // minimum or maximum for numeric types
    maximum? : number
}

export type Tool = {
    name: string
    description: string
    parameters: ToolParameter[]
    required? : string[] // TODO can this be more precisely typed?
}
