import type { Tool } from "../types/tool"

export type ExecToolSpec = {
    exec: string
    usage?: string
    name?: string
}

export function isExecToolSpec(raw : unknown) : raw is ExecToolSpec {
    return raw !== null &&
        typeof raw === "object" &&
        "exec" in raw &&
        ("usage" in raw ? typeof raw.exec === "string" : true) &&
        ("name" in raw ? typeof raw.exec === "string" : true)
}


export class ExecTool implements Tool {

    name: string
    exec: string
    description: string
    static count : number = 0

    constructor(spec: ExecToolSpec) {
        this.exec = spec.exec
        this.name = spec.name ?? `exec_tool_${ExecTool.count}`
        this.description = 
            `This tool executes \`${this.exec}\` directly, with the array of arguments (including command line flags) that you supply.` +
            `So for example if you supply \`$arguments\`, what is run is literally \`bash -c "${this.exec} $arguments"\`.` +
            `The execution does not take place in a shell, so arguments must not use command substitution or otherwise rely on shell features.` +
            `The stdout resulting from the command will be returned to you as the tool call result.` +
            `The user cannot see the tool call result. You must explicitly report any requested information to the user.` +
            (spec.usage ?? "")
        ExecTool.count++
    }

    parameters = {
        arguments : {
            type : "array",
            description : "the arguments to the command",
            items : {
                type: "string"
            }
        }
    } as const

    async call(args : { arguments : string[] }) : Promise<string> {
        // need better error handling here
        const proc = Bun.spawnSync([this.exec].concat(args.arguments))
        if (proc.exitCode !== 0) {
            throw Error(proc.stderr.toString())
        } else {
            return proc.stdout.toString()
        }
    }
}
