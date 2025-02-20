import type { ExecToolSpec } from "../tools/exec_tool"
import type { Tool } from "./tool"
import { isExecToolSpec, ExecTool } from "../tools/exec_tool"

export type ToolSpec = ExecToolSpec

export const ToolRegistry : {[key : string] : Tool} = {
}

export function isToolSpec(spec : unknown) : spec is ToolSpec {
    return isExecToolSpec(spec)
}

export function initRegistry(specs : ToolSpec[]) : {[key : string] : Tool} {
    if (Object.keys(ToolRegistry).length > 0) return ToolRegistry
    for (const spec of specs) {
        if (isExecToolSpec(spec)) {
            const tool = new ExecTool(spec)
            ToolRegistry[tool.name] = tool
        } 
        // TODO: need to decide how to handle malformed specs.
        // Throw error? Return error? log warning?
    }
    return ToolRegistry
}
