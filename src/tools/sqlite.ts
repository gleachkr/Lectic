import { ToolCallResults, Tool, type ToolCallResult } from "../types/tool"
import { Database } from "bun:sqlite"

export type SQLiteToolSpec = {
    sqlite: string
    details?: string
    name?: string
    limit? : number
}

export function isSQLiteToolSpec(raw : unknown) : raw is SQLiteToolSpec {
    return raw !== null &&
        typeof raw === "object" &&
        "sqlite" in raw &&
        ("name" in raw ? typeof raw.name === "string" : true)
}

const description = `
This tool gives you access to an sqlite database. You can issue an SQLITE query or statement, and you will receive the results.

1. In order to avoid overwhelming you with extraneous information, results larger than a fixed size will result in an error. 
2. **IMPORTANT**: The tool accepts *one statement at a time*. If you provide multiple statements, statements after the first will be silently ignored. For example,

    CREATE TABLE tableA(x INT); CREATE TABLE tableB(x INT);

Will only create "tableA", the second table will not be created. If you need to execute multiple statements, then you will need to call the tool more than once.

`


export class SQLiteTool extends Tool {

    name: string
    details: string | undefined
    limit: number | undefined
    db: Database
    static count : number = 0

    constructor(spec: SQLiteToolSpec) {
        super()
        this.name = spec.name ?? `sqlite_tool_${SQLiteTool.count}`
        this.details = spec.details
        this.limit = spec.limit

        this.db = new Database(spec.sqlite)
        this.db.exec("PRAGMA foreign_keys = ON")
    }

    get description() {
        const schemas = this.db.query(`
             SELECT m.tbl_name AS table_name, m.sql AS create_statement FROM 
                 sqlite_master m
             WHERE 
                 m.tbl_name NOT LIKE 'sqlite_%';`).all()
        return description + 
            `Here are the current tables, views, indexes and triggers with their schemas: ${JSON.stringify(schemas)}.` +
            `This information updates automatically, so it will reflect the results of any changes you make.` +
            `${this.details ? `Here are some additional details about the database: ${this.details}` : "" }`
    }

    parameters = {
        query: {
            type : "string",
            description : "the SQL query to be executed",
        }
    } as const

    required = ["query"]

    async call(args : { query : string }) : Promise<ToolCallResult[]> {
        // need better error handling here
        const rslt_rows = this.db.query(args.query).values()
        // Something's off with bun's provided types, rslt_rows can be null in practice.
        if (Array.isArray(rslt_rows)) {
            for (const row of rslt_rows) {
                for (const col of row) {
                    if (col instanceof Uint8Array) {
                        throw Error("result contained a BLOB column, try refining to select only readable columns.")
                    }
                }
            }
        }
        const rslt = rslt_rows === null ? "Success" : JSON.stringify(rslt_rows)
        if (rslt.length < (this.limit ?? 10_000)) {
            return ToolCallResults(rslt)
        } else {
            throw Error("result was too large, try an more selective query.")
        }
    }
}
