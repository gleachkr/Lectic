import { ToolCallResults, Tool, type ToolCallResult } from "../types/tool"
import { lecticEnv } from "../utils/xdg";
import * as fs from "fs";
import { withTimeout, TimeoutError } from "../utils/timeout";
import { readStream } from "../utils/stream";

export type ExecToolSpec = {
    exec: string
    usage?: string
    name?: string
    sandbox?: string
    confirm?: string
    env?: Record<string, string>
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
        ("timeoutSeconds" in raw ? typeof (raw as any).timeoutSeconds === "number" : true) &&
        ("env" in raw 
            ? typeof raw.env === "object" && 
                raw.env !== null && 
                Object.values(raw.env).every(v => typeof v === "string")
            : true
        )
}

async function spawnScript(
    script : string,
    args : string[],
    sandbox: string | undefined,
    env: Record<string, string>
) {
    if (script.slice(0,2) !== "#!") {
        throw Error("expected shebang in first line of executable script")
    }
    const shebangArgs = script.slice(2).split('\n')[0].trim().split(' ')
    const tmpName = `./.lectic_script-${Bun.randomUUIDv7()}`
    const cleanup = () => fs.existsSync(tmpName) && fs.unlinkSync(tmpName)
    process.on('exit', cleanup)
    await Bun.write(tmpName, script)
    const proc = Bun.spawn([
        ...(sandbox ? [sandbox] : []),
        ...shebangArgs,
        tmpName,
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
    const proc = Bun.spawn([
        ...(sandbox ? [sandbox] : []),
        command,
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
        this.sandbox = spec.sandbox
        this.confirm = spec.confirm
        this.env = { LECTIC_INTERLOCUTOR: interlocutor_name, ...spec.env ?? {} }
        this.timeoutSeconds = spec.timeoutSeconds
        this.description = (this.isScript 
            ? `This tool executes the following script: \n \`\`\`\n${this.exec}\n\`\`\`\n` +
            `The script is applied to the array of arguments that you supply, in the order that they are supplied. ` +
             `So for example if you supply ARG_ONE and ARG_TWO, what is run is \`the_script "ARG_ONE" "ARG_TWO"\`. `
            : `This tool executes the command \`${this.exec}\`` +
              `The command is applied to the array of arguments that you supply, in the order that they are supplied. ` + 
               `So for example if you supply ARG_ONE and ARG_TWO, what is run is literally \`"${this.exec} "ARG_ONE" "ARG_TWO"\`. ` +
            `If the command requires command line flags, those should be included in the list of arguments. `) +
            `The execution does not take place in a shell, so arguments must not use command substitution or otherwise rely on shell features. ` +
            `The user cannot see the tool call result. You must explicitly report any requested information to the user. ` +
            (spec.usage ?? "")
        ExecTool.count++
    }

    parameters = {
        arguments : {
            type : "array",
            description : "the arguments to the command",
            items : {
                type: "string",
                description: "a command argument"
            }
        }
    } as const

    required = ["arguments"]

    async call(args : { arguments : string[] }) : Promise<ToolCallResult[]> {
        this.validateArguments(args);
        if (this.confirm) {
            const proc = Bun.spawnSync([this.confirm, this.name, JSON.stringify(args,null,2)], {
                env: { ...process.env, ...lecticEnv }
            })
            if (proc.exitCode !==0) {
                throw Error(`<error>Tool use permission denied</error>`)
            }
        }

        let proc = null
        let cleanup = () => {}

        if (this.isScript) {
            ({proc, cleanup} = await spawnScript(
                this.exec,
                args.arguments,
                this.sandbox,
                this.env
            ))
        } else {
            proc = spawnCommand(
                this.exec,
                args.arguments,
                this.sandbox,
                this.env
            )
        }

        const collected = { stdout: "", stderr: "" }
        const rslt = Promise.all([
            readStream(proc.stdout, s => collected.stdout += s),
            readStream(proc.stderr, s => collected.stderr += s),
        ]).then(() => proc.exited)

        try {
            const code = await (this.timeoutSeconds && this.timeoutSeconds > 0
                ? withTimeout(rslt, this.timeoutSeconds, "command", { onTimeout: proc.kill } )
                : rslt)

            const results: string[] = []
            if (collected.stdout.length > 0) results.push(`<stdout>${collected.stdout}</stdout>`)
            if (collected.stderr.length > 0) results.push(`<stderr>${collected.stderr}</stderr>`)
            if (code !== 0) results.push(`<exitCode>${code}</exitCode>`)
            return ToolCallResults(results)
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
