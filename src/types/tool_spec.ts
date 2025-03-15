import type { ExecToolSpec } from "../tools/exec"
import type { Tool } from "./tool"
import { isExecToolSpec, ExecTool } from "../tools/exec"
import type { SQLiteToolSpec } from "../tools/sqlite"
import { isSQLiteToolSpec, SQLiteTool } from "../tools/sqlite"
import type { TavilyToolSpec } from "../tools/tavily"
import { isTavilyToolSpec, TavilyTool } from "../tools/tavily"

export type ToolSpec = ExecToolSpec | SQLiteToolSpec | TavilyToolSpec

export const ToolRegistry : {[key : string] : Tool} = {}

export function isToolSpec(spec : unknown) : spec is ToolSpec {
    return isExecToolSpec(spec) || isSQLiteToolSpec(spec) || isTavilyToolSpec(spec)
}

export function initRegistry(specs : ToolSpec[]) : {[key : string] : Tool} {
    if (Object.keys(ToolRegistry).length > 0) return ToolRegistry
    for (const spec of specs) {

        let tool
        if (isExecToolSpec(spec)) {
            tool = new ExecTool(spec)
        } else if (isSQLiteToolSpec(spec)) {
            tool = new SQLiteTool(spec)
        } else if (isTavilyToolSpec(spec)) {
            tool = new TavilyTool(spec)
        }
        
        // TODO: need to better decide how to handle malformed specs.
        // Throw error? Return error? log warning?
        if (!tool) {
            throw Error("One or more tools provided were not recognized. Check the tool section of your YAML header.")
        }
        // TODO: need to better handle name collisions, maybe namespacing default/custom names in some way.
        if (tool.name in ToolRegistry) {
            throw Error("Two tools were given the same name. Check the tool section of your YAML header.") 
        }
        ToolRegistry[tool.name] = tool
    }
    return ToolRegistry
}
