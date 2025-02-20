import type { Tool } from "../types/tool"
import { $ } from "bun"

export type ExecToolSpec = {
    exec: string
    usage? : string
}

export function isExecToolSpec(raw : unknown) : raw is ExecToolSpec {
    return raw !== null &&
        typeof raw === "object" &&
        "exec" in raw &&
        ("usage" in raw ? typeof raw.exec === "string" : true)
}


export class ExecTool implements Tool {

    name: string
    command: string
    description: string
    static count : number = 0

    constructor(spec: ExecToolSpec) {
        this.command = spec.exec
        this.name = `exec_tool_${ExecTool.count}`
        this.description = 
            `This tool executes \`${this.command}\` in a bash shell with the arguments (including command line flags) that you supply.` +
            `So for example if you supply \`$arguments\`, what is run is literally \`bash -c "${this.command} $arguments"\`.` +
            `The stdout resulting from the command will be returned to you as the tool call result.` +
            (spec.usage ?? "")
        ExecTool.count++
    }

    parameters = {
        arguments : {
            type : "string",
            description : "the arguments to the command"
        }
    } as const

    async call(args : { arguments : string }) : Promise<string> {
        // neet better error handling here
        return $`bash -c '${this.command} ${args.arguments}'`.text()
    }

}
