import { ToolCallResults, Tool, type ToolCallResult } from "../types/tool"
import { lecticEnv } from "../utils/xdg";
import { withTimeout, TimeoutError } from "../utils/timeout";
import { readStream } from "../utils/stream";
import { expandEnv } from "../utils/replace";
import { parseCommandToArgv, writeTempShebangScriptAsync } from "../utils/execHelpers";
import type { JSONSchema } from "../types/schema.ts"

export type ExecToolSpec = {
    exec: string
    usage?: string
    name?: string
    sandbox?: string
    confirm?: string
    env?: Record<string, string>
    schema?: Record<string, string>
    timeoutSeconds?: number
}

export function isExecToolSpec(raw : unknown) : raw is ExecToolSpec {
    return raw !== null &&
        typeof raw === "object" &&
        "exec" in raw &&
        typeof raw.exec === "string" &&
        ("usage" in raw ? typeof raw.usage === "string" : true) &&
        ("name" in raw ? typeof raw.name === "string" : true) &&
        ("confirm" in raw ? typeof raw.confirm === "string" : true) &&
        ("timeoutSeconds" in raw ? typeof raw.timeoutSeconds === "number" : true) &&
        ("env" in raw 
            ? typeof raw.env === "object" && raw.env !== null && 
                Object.values(raw.env).every(v => typeof v === "string")
            : true
        ) &&
        ("schema" in raw ? 
                typeof raw.schema=== "object" && raw.schema !== null && 
                Object.values(raw.schema).every(v => typeof v === "string")
            : true
        )
}

/**
 * Sanitize CLI output for LLM consumption.
 * - Normalizes CRLF to LF.
 * - Strips ANSI/escape sequences (colors, cursor moves, OSC, etc.).
 * - Collapses carriage-return overwrites, keeping the final state
 *   on each line.
 *
 * Example: "\x1b[31mLoading\x1b[0m 10%\rDone!" → "Done!"
 */
function sanitizeCliOutput(s: string): string {
    // Normalize CRLF first so we can reason about lines
    let t = s.replace(/\r\n/g, "\n")

    // Strip OSC (Operating System Command) sequences like
    // ESC ] ... BEL or ESC ] ... ESC \
    t = t.replace(/\u001B\][^\u0007]*(?:\u0007|\u001B\\)/g, "")

    // Strip CSI and other common ANSI sequences
    // Source pattern adapted from sindresorhus/strip-ansi
    const ansiRe = /[\u001B\u009B][[\\]()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-PR-TZcf-nq-uy=><]/g
    t = t.replace(ansiRe, "")
    // Fallback: strip generic CSI (ESC[ ... final byte) sequences
    t = t.replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, "")

    // Finally, collapse carriage-return overwrites per line
    t = t.split("\n").map((line) => {
        const lastCR = line.lastIndexOf("\r")
        return lastCR >= 0 ? line.slice(lastCR + 1) : line
    }).join("\n")

    return t
}

async function spawnScript(
    script : string,
    args : string[],
    sandbox: string | undefined,
    env: Record<string, string>
) {
    const { path, shebangArgs, cleanup } = await writeTempShebangScriptAsync(script)
    const proc = Bun.spawn([
        ...(sandbox ? [sandbox] : []),
        ...shebangArgs,
        path,
        ...args
    ], {
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, ...lecticEnv, ...env }
    })
    return { proc, cleanup }
}

function spawnCommand(
    command: string,
    args: string[],
    sandbox: string | undefined,
    env: Record<string, string>
) {

    const parts = parseCommandToArgv(command)
    if (parts.length === 0) {
        throw Error(`Could not read command ${command}`)
    }

    const proc = Bun.spawn([
        ...(sandbox ? [sandbox] : []),
        ...parts,
        ...args
    ], {
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, ...lecticEnv, ...env }
    })
    return proc
}

export class ExecTool extends Tool {

    name: string
    exec: string
    isScript: boolean
    sandbox?: string
    description: string
    confirm?: string
    env: Record<string, string>
    timeoutSeconds?: number
    static count : number = 0

    constructor(spec: ExecToolSpec, interlocutor_name : string) {
        super()
        this.exec = spec.exec
        this.name = spec.name ?? `exec_tool_${ExecTool.count}`
        this.isScript = this.exec.split('\n').length > 1
        this.env = { LECTIC_INTERLOCUTOR: interlocutor_name, ...spec.env ?? {} }
        this.sandbox = spec.sandbox ? expandEnv(spec.sandbox, this.env) : spec.sandbox
        this.confirm = spec.confirm ? expandEnv(spec.confirm, this.env) : spec.confirm
        this.timeoutSeconds = spec.timeoutSeconds

        if (spec.schema) {
            this.parameters = {}
            for (const [key,value] of Object.entries(spec.schema)) {
                this.parameters[key] = { type: "string", description: value }
            }
            this.required = Object.keys(this.parameters)
        } 

        this.description = (this.isScript 
            ? `This tool executes the following script: \n \`\`\`\n${this.exec}\n\`\`\`\n` +
              (spec.schema 
                  ? `The parameters to the tool call are supplied as environment variables, so for example if you supply ` +
                    `an argument named FOO, assigning it the string "BAR", then in the script, $FOO will have the value "BAR". `
                  : `The script is applied to the array of arguments that you supply, in the order that they are supplied. ` +
                    `So for example if you supply ARG_ONE and ARG_TWO, what is run is \`the_script "ARG_ONE" "ARG_TWO"\`. `)
            : `This tool executes the command \`${this.exec}\`` +
               (spec.schema ? `The parameters to the tool call are supplied as environment variables, so for example if you supply ` +
                 `an argument named FOO, assigning it the string "BAR", then in the environment in which the command is executed, `  +
                 `$FOO will will have the value "BAR"`
               : `The command is applied to the array of arguments that you supply, in the order that they are supplied. ` + 
                 `So for example if you supply ARG_ONE and ARG_TWO, what is run is literally \`"${this.exec} "ARG_ONE" "ARG_TWO"\`. ` +
                 `If the command requires command line flags, those should be included in the list of arguments. `)) +
            `The execution does not take place in a shell, so arguments must not use command substitution or otherwise rely on shell features. ` +
            `The user cannot see the tool call result. You must explicitly report any requested information to the user. ` +
            (spec.usage ?? "")
        ExecTool.count++
    }

    parameters : { [key : string] : JSONSchema } = {
        argv : {
            type : "array",
            description : "the arguments to the command",
            items : {
                type: "string",
                description: "a command argument"
            }
        }
    } 

    required = ["argv"]

    async call(params: { argv : string[] } | Record<string,string> ) : Promise<ToolCallResult[]> {
        this.validateArguments(params);

        const args = Array.isArray(params.argv) ? params.argv : []
        const env = Array.isArray(params.argv) ? this.env : {...params, ...this.env} as Record<string,string>

        if (this.confirm) {
            const proc = Bun.spawnSync([this.confirm, this.name, JSON.stringify(params, null, 2)], {
                env: { ...process.env, ...lecticEnv }
            })
            if (proc.exitCode !==0) {
                throw Error(`<error>Tool use permission denied</error>`)
            }
        }

        let proc = null
        let cleanup = () => {}

        if (this.isScript) {
            ({proc, cleanup} = await spawnScript(this.exec, args, this.sandbox, env))
        } else {
            proc = spawnCommand(expandEnv(this.exec, env), args, this.sandbox, env)
        }

        const collected = { stdout: "", stderr: "" }
        const rslt = Promise.all([
            readStream(proc.stdout, s => collected.stdout += s),
            readStream(proc.stderr, s => collected.stderr += s),
        ]).then(() => proc.exited).then((code) => {
            // Clean up CLI output after collection is complete
            collected.stdout = sanitizeCliOutput(collected.stdout)
            collected.stderr = sanitizeCliOutput(collected.stderr)
            return code
        })

        try {
            const code = await (this.timeoutSeconds && this.timeoutSeconds > 0
                ? withTimeout(rslt, this.timeoutSeconds, "command", { onTimeout: proc.kill } )
                : rslt)

            const results: string[] = []
            if (collected.stdout.length > 0) results.push(`<stdout>${collected.stdout}</stdout>`)
            if (collected.stderr.length > 0) results.push(`<stderr>${collected.stderr}</stderr>`)
            if (code !== 0) results.push(`<exitCode>${code}</exitCode>`)
            return ToolCallResults(results, "application/xml")
        } catch (e) {
            if (e instanceof TimeoutError) {
                // Surface stdout/stderr along with a timeout error indicator.
                const chunks: string[] = []
                if (collected.stdout.length > 0) chunks.push(`<stdout>${collected.stdout}</stdout>`)
                if (collected.stderr.length > 0) chunks.push(`<stderr>${collected.stderr}</stderr>`)
                chunks.push(`<error>Killed Process: ${e.message}</error>`)
                throw new Error(chunks.join(""))
            }
            throw e
        } finally {
            cleanup()
        }
    }
}
