import type { ExecToolSpec } from "../tools/exec_tool"
import type { Tool } from "./tool"
import { isExecToolSpec, ExecTool } from "../tools/exec_tool"

export type ToolSpec = ExecToolSpec

export const ToolRegistry : {[key : string] : Tool} = {}

export function isToolSpec(spec : unknown) : spec is ToolSpec {
    return isExecToolSpec(spec)
}

export function initRegistry(specs : ToolSpec[]) : {[key : string] : Tool} {
    if (Object.keys(ToolRegistry).length > 0) return ToolRegistry
    for (const spec of specs) {

        let tool
        if (isExecToolSpec(spec)) {
            tool = new ExecTool(spec)
        }
        
        // TODO: need to better decide how to handle malformed specs.
        // Throw error? Return error? log warning?
        if (!tool) throw Error("One or more tools provided were not recognized. Check the tool section of your YAML header.")
        // TODO: need to better handle name collisions, maybe namespacing default/custom names in some way.
        if (tool.name in ToolRegistry) throw Error("Two tools were given the same name. Check the tool section of your YAML header.") 
        ToolRegistry[tool.name] = tool
    }
    return ToolRegistry
}
