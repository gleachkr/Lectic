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
        typeof raw.exec === "string" &&
        ("usage" in raw ? typeof raw.usage === "string" : true) &&
        ("name" in raw ? typeof raw.name === "string" : true) &&
        ("confirm" in raw ? typeof raw.confirm === "string" : true)
}

function execScript(script : string,  args : string[], sandbox: string | undefined,) {
    if (script.slice(0,2) !== "#!") {
        throw Error("expected shebang in first line of executable script")
    }
    const shebangArgs = script.slice(2).split('\n')[0].trim().split(' ')
    const tmpName = `./${Bun.randomUUIDv7()}`
    Bun.write(tmpName, script)
    const proc = Bun.spawnSync([
        ...(sandbox ? [sandbox] : []), 
        ...shebangArgs, 
        tmpName, 
        ...args], { stderr: "pipe" })
    Bun.file(tmpName).delete()
    return proc
}

export class ExecTool extends Tool {

    name: string
    exec: string
    isScript: boolean
    sandbox?: string
    description: string
    confirm?: string
    static count : number = 0

    constructor(spec: ExecToolSpec) {
        super()
        this.exec = spec.exec
        this.name = spec.name ?? `exec_tool_${ExecTool.count}`
        this.isScript = this.exec.split('\n').length > 1
        this.sandbox = spec.sandbox
        this.confirm = spec.confirm
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
        if (this.confirm) {
            const proc = Bun.spawnSync([this.confirm, this.name, JSON.stringify(args,null,2)])
            if (proc.exitCode !==0) {
                throw Error(`<error>Tool use permission denied</error>`)
            }
        }

        const proc = this.isScript
            ? execScript(this.exec, args.arguments, this.sandbox)
            : Bun.spawnSync([
                ...(this.sandbox ? [this.sandbox] : []), 
                this.exec, 
                ...args.arguments], { stderr: "pipe" })

        const results = []
        const stdout = proc.stdout.toString()
        const stderr = proc.stderr.toString()

        if (stdout.length > 0) results.push(`<stdout>${stdout}</stdout>`)
        if (stderr.length > 0) results.push(`<stderr>${stderr}</stderr>`)
        if (proc.exitCode != 0) results.push(`<exitCode>${proc.exitCode}</exitCode>`)
        return ToolCallResults(results)
    }
}
