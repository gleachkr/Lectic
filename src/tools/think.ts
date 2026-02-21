import { isHookSpecList, type HookSpec } from "../types/hook"
import { ToolCallResults, Tool, type ToolCallResult } from "../types/tool"

export type ThinkToolSpec = {
    think_about: string
    name?: string
    icon?: string
    usage?: string
    hooks?: HookSpec[]
}

export function isThinkToolSpec(raw : unknown) : raw is ThinkToolSpec {
    return raw !== null 
    && typeof raw === "object" 
    && "think_about" in raw
    && ("icon" in raw ? typeof raw.icon === "string" : true)
    && ("hooks" in raw ? isHookSpecList(raw.hooks) : true)
}

export class ThinkTool extends Tool {

    name: string
    kind = "think"
    icon: string
    description: string
    static count : number = 0

    constructor(spec: ThinkToolSpec) {
        super(spec.hooks)
        this.name = spec.name ?? `think_tool_${ThinkTool.count}`
        this.icon = spec.icon ?? ""
        this.description = 
            `Use the tool to think about ${spec.think_about}. ` +
            `It will not obtain new information or change anything, but just append the thought to the log. ` +
            `Use it when complex reasoning or some cache memory is needed. ` + (spec.usage || "")

        ThinkTool.count++
    }

    parameters = {
        thought: {
            type : "string",
            description : "A thought to think about",
        }
    } as const

    required = ["thought"]

    async call(args : { thought : string }) : Promise<ToolCallResult[]> {
        this.validateArguments(args);
        return ToolCallResults("thought complete.")
    }
}
