import { describe, it, expect } from "bun:test";
import { Hook } from "./hook";
import { Tool, ToolCallResults } from "./tool";
import { resolveToolCalls, type ToolRegistry } from "../backends/common";

class MockTool extends Tool {
    name = "mock_tool"
    description = "A mock tool"
    parameters = { }
    required = []
    
    constructor(hooks?: any[]) {
        super(hooks)
    }

    async call(_: unknown) {
        return ToolCallResults("success")
    }
}

describe("Tool Hooks", () => {
    it("should execute a scoped hook when the tool is called", async () => {
        // Use a hook that runs 'true' (exit code 0) and check if it passes.
        // Use one that runs 'false' (exit code 1) and check if it blocks.
        
        const passingHook = {
            on: "tool_use_pre",
            do: "true"
        }
        
        const blockingHook = {
            on: "tool_use_pre",
            do: "false"
        }

        const toolWithPass = new MockTool([passingHook])
        const registryPass: ToolRegistry = { "mock_tool": toolWithPass }
        
        const entriesPass = [{ name: "mock_tool", args: {} }]
        const resultsPass = await resolveToolCalls(entriesPass, registryPass)
        
        expect(resultsPass[0].isError).toBe(false)
        expect(resultsPass[0].results[0].content).toBe("success")

        const toolWithBlock = new MockTool([blockingHook])
        const registryBlock: ToolRegistry = { "mock_tool": toolWithBlock }
        
        const entriesBlock = [{ name: "mock_tool", args: {} }]
        
        // resolveToolCalls catches the error thrown by the hook and returns it as a result
        const resultsBlock = await resolveToolCalls(entriesBlock, registryBlock)
        
        // When hook fails, it throws "Tool use permission denied", which is caught
        // and returned as a result with isError: true.
        expect(resultsBlock[0].isError).toBe(true)
        expect(resultsBlock[0].results[0].content).toBe("Tool use permission denied")
    })

    it("should combine global and local hooks", async () => {
         const tool = new MockTool([])
         const registry: ToolRegistry = { "mock_tool": tool }
         
         // Mock the Lectic object to provide global hooks
         const globalHooks = [new Hook({ on: "tool_use_pre", do: "false" })]
         const mockLectic = {
             header: {
                 hooks: globalHooks,
                 interlocutor: {
                     active_hooks: []
                 }
             }
         }
         
         const entries = [{ name: "mock_tool", args: {} }]
         const results = await resolveToolCalls(entries, registry, { lectic: mockLectic as any })
         
         expect(results[0].isError).toBe(true)
         expect(results[0].results[0].content).toBe("Tool use permission denied")
    })

    it("should respect interlocutor scoped hooks", async () => {
         const tool = new MockTool([])
         const registry: ToolRegistry = { "mock_tool": tool }

         // Case 1: Interlocutor active_hooks includes a blocking hook
         const blockingHooks = [new Hook({ on: "tool_use_pre", do: "false" })]
         const mockLecticBlock = {
             header: {
                 hooks: [], // No global hooks
                 interlocutor: {
                     active_hooks: blockingHooks
                 }
             }
         }

         const entries = [{ name: "mock_tool", args: {} }]
         const resultsBlock = await resolveToolCalls(entries, registry, { lectic: mockLecticBlock as any })

         expect(resultsBlock[0].isError).toBe(true)
         expect(resultsBlock[0].results[0].content).toBe("Tool use permission denied")

         // Case 2: Interlocutor active_hooks is empty (or passing)
         const mockLecticPass = {
             header: {
                 hooks: [],
                 interlocutor: {
                     active_hooks: []
                 }
             }
         }

         const resultsPass = await resolveToolCalls(entries, registry, { lectic: mockLecticPass as any })
         expect(resultsPass[0].isError).toBe(false)
    })
})
