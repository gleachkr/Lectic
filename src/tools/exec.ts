import { ToolCallResults, Tool, type ToolCallResult } from "../types/tool"

export type ExecToolSpec = {
    exec: string
    usage?: string
    name?: string
    sandbox?: string
    confirm?: string
}

export function isExecToolSpec(raw : unknown) : raw is ExecToolSpec {
    return raw !== null &&
        typeof raw === "object" &&
        "exec" in raw &&
        ("usage" in raw ? typeof raw.usage=== "string" : true) &&
        ("name" in raw ? typeof raw.name === "string" : true) &&
        ("confirm" in raw ? typeof raw.confirm === "string" : true)
}


export class ExecTool extends Tool {

    name: string
    exec: string
    sandbox?: string
    description: string
    confirm?: string
    static count : number = 0

    constructor(spec: ExecToolSpec) {
        super()
        this.exec = spec.exec
        this.name = spec.name ?? `exec_tool_${ExecTool.count}`
        this.sandbox = spec.sandbox
        this.confirm = spec.confirm
        this.description = 
            `This tool executes the command \`${this.exec}\` directly, applied to the array of arguments (including command line flags) `
            + `that you supply. So for example if you supply \`$arguments\`, what is run is literally \`"${this.exec} $arguments"\`. ` +
            `The execution does not take place in a shell, so arguments must not use command substitution or otherwise rely on shell features. ` +
            `The stdout resulting from the command will be returned to you as the tool call result. ` +
            `The user cannot see the tool call result. You must explicitly report any requested information to the user.` +
            (spec.usage ?? "")
        ExecTool.count++
        this.register()
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
        if (this.confirm) {
            const proc = Bun.spawnSync([this.confirm, this.name, JSON.stringify(args,null,2)])
            if (proc.exitCode !==0) {
                throw Error(`<error>Tool use permission denied</error>`)
            }
        }

        const spawned = this.sandbox 
            ? [this.sandbox, this.exec].concat(args.arguments)
            : [this.exec].concat(args.arguments)

        const proc = Bun.spawnSync(spawned)
        if (proc.exitCode !== 0) {
            throw Error(proc.stderr.toString())
        } else {
            return ToolCallResults(`<stdout>${proc.stdout.toString()}</stdout>`)
        }
    }
}
