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
        this.register()
    }

    get description() {
        const schemas = this.db.query(`
             SELECT m.tbl_name AS table_name, m.sql AS create_statement FROM 
                 sqlite_master m
             WHERE 
                 m.type = 'table' AND
                 m.tbl_name NOT LIKE 'sqlite_%';`).all()
        return `This tool gives you access to an sqlite database. You can issue SQL queries, and you will receive the results. ` +
            `In order to avoid overwhelming you with extraneous information, results larger than a fixed size will result in an error. ` +
            `Here are the current tables with their schemas: ${JSON.stringify(schemas)}.` +
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
        const rslt_rows = this.db.query(args.query).all()
        for (const row of rslt_rows) {
            if (row instanceof Uint8Array || row instanceof Buffer) {
                throw Error("result contained a BLOB column, try refining to select only readable columns.")
            }
            if (row instanceof Array) {
                for (const col of row) {
                    if (col instanceof Uint8Array || col instanceof Buffer) {
                        throw Error("result contained a BLOB column, try refining to select only readable columns.")
                    }
                }
            }
        }
        const rslt = JSON.stringify(rslt_rows)
        if (rslt.length < (this.limit ?? 10_000)) {
            return ToolCallResults(JSON.stringify(rslt))
        } else {
            throw Error("result was too large, try an more selective query.")
        }
    }
}
