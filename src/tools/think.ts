import { ToolCallResults, Tool, type ToolCallResult } from "../types/tool"

export type ThinkToolSpec = {
    think_about: string
    name?: string
    usage?: string
}

export function isThinkToolSpec(raw : unknown) : raw is ThinkToolSpec {
    return raw !== null && typeof raw === "object" && "think_about" in raw
}

export class ThinkTool extends Tool {

    name: string
    sandbox: string | undefined
    description: string
    static count : number = 0

    constructor(spec: ThinkToolSpec) {
        super()
        this.name = spec.name ?? `think_tool_${ThinkTool.count}`
        this.description = 
            `Use the tool to think about ${spec.think_about}. ` +
            `It will not obtain new information or change anything, but just append the thought to the log. ` +
            `Use it when complex reasoning or some cache memory is needed. ` + (spec.usage || "")

        ThinkTool.count++
        this.register()
    }

    parameters = {
        thought: {
            type : "string",
            description : "A thought to think about",
        }
    } as const

    required = ["thought"]

    async call(_args : { arguments : string[] }) : Promise<ToolCallResult[]> {
        return ToolCallResults("thought complete.")
    }
}
