import { ToolCallResults, Tool, type ToolCallResult } from "../types/tool"
import { Database } from "bun:sqlite"
import { parse, show, type Statement } from "sql-parser-cst"
import { expandEnv } from "../utils/replace";
import * as YAML from "yaml"

export type SQLiteToolSpec = {
    sqlite: string
    details?: string
    name?: string
    limit? : number
    extensions?: string[] | string
}

export function isSQLiteToolSpec(raw : unknown) : raw is SQLiteToolSpec {
    return raw !== null &&
        typeof raw === "object" &&
        "sqlite" in raw &&
        ("name" in raw ? typeof raw.name === "string" : true) &&
        ("limit" in raw ? typeof raw.limit=== "number" : true) &&
        ("details" in raw ? typeof raw.details=== "string" : true) &&
        ("extensions" in raw 
            ? typeof raw.extensions === "string" ||
              Array.isArray(raw.extensions) && raw.extensions.every(ext => typeof ext === "string")
            : true
        )
}

const description = `
This tool gives you access to an sqlite database. You can provide well-formed SQLite script, and you will receive the results, encoded as YAML.

In order to avoid overwhelming you with extraneous information, results larger than a fixed size will result in an error. 

If your SQLITE script contains multiple statements, you'll receive the results in the order that the statements were provided.

Each tool call is handled atomically: changes are rolled back if any error occurs. So if you see an error, you can infer that your tool call had no effect on the database.
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

        this.db = new Database(expandEnv(spec.sqlite))
        try {
            switch (typeof spec.extensions) {
                case "string" : this.db.loadExtension(spec.extensions); break
                case "object" : spec.extensions.forEach(ext => this.db.loadExtension(ext)); break
            }
        } catch(e) {
            throw Error(`Something went wrong while trying to load an sqlite extension: ${e}` +
                        `\n\n NOTE: on MacOS you may be running into a limitation of the OS's standard sqlite build,` +
                        ` see https://bun.sh/docs/api/sqlite#loadextension.`)
        }
        this.db.run("PRAGMA foreign_keys = ON")

        SQLiteTool.count++
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

    async call({ query }: { query : string }) : Promise<ToolCallResult[]> {

        this.validateArguments({ query });

        const parsed = parse(query, {
            dialect: "sqlite",
            includeComments: true,
            includeSpaces: true,
            includeNewlines: true,
        })

        const rslts : string[] = []
        // This is pretty delicate. I think there's a bun sqlite bug where it
        // thinks that some of the queries below are finalized when they
        // shouldn't be, if we write this as a regular loop. A forEach seems to work though.
        const processStatements = this.db.transaction(statements => {
            statements.forEach((statement : Statement) => {
                const raw = show(statement)
                if (raw.length === 0) return
                const rslt_rows = []
                for (const row of this.db.query(raw).iterate()) {
                    if (typeof row === "object" && row !== null) {
                        for (const col of Object.values(row)) {
                            if (col instanceof Uint8Array) {
                                throw Error("result contained a BLOB column, try refining to select only readable columns.")
                            }
                        }
                        rslt_rows.push(row)
                    }
                }
                // LLMs seem to find YAML easier to read than JSON - JSON does
                // some string sanitization, like '\n' for newlines, which the
                // LLM will sometimes think is just part of the string.
                const rslt = YAML.stringify(rslt_rows)
                if (rslt.length > (this.limit ?? 10_000)) {
                    throw Error("result was too large, try a more selective query.")
                }
                rslts.push(rslt)
            })
        })
        processStatements(parsed.statements)
        return ToolCallResults(rslts)
    }
}
