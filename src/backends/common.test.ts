import { describe, it, expect } from "bun:test"
import { runHooks, emitAssistantMessageEvent, resolveToolCalls } from "./common"
import { Hook } from "../types/hook"
import { Tool, ToolCallResults } from "../types/tool"

describe("runHooks", () => {
    it("handles simple text output without headers", () => {
        const hook = new Hook({
            on: "user_message",
            do: "echo 'hello world'",
            inline: true
        })
        
        const results = runHooks([hook], "user_message", {})
        expect(results).toHaveLength(1)
        expect(results[0].content.trim()).toBe("hello world")
        expect(results[0].attributes).toBeUndefined()
    })

    it("parses LECTIC headers into attributes", () => {
        const hook = new Hook({
            on: "user_message",
            do: `#!/bin/bash
echo "LECTIC:CTX:reset"
echo "LECTIC:FOO:bar"
echo ""
echo "actual content"`,
            inline: true
        })
        
        const results = runHooks([hook], "user_message", {})
        expect(results).toHaveLength(1)
        expect(results[0].attributes).toEqual({
            ctx: "reset",
            foo: "bar"
        })
        expect(results[0].content.trim()).toBe("actual content")
    })

    it("parses headers without values", () => {
        const hook = new Hook({
            on: "user_message",
            do: `#!/bin/bash
echo "LECTIC:final"
echo "content"`,
            inline: true
        })
        
        const results = runHooks([hook], "user_message", {})
        expect(results).toHaveLength(1)
        expect(results[0].attributes).toEqual({
            final: "true"
        })
        expect(results[0].content.trim()).toBe("content")
    })

    it("parses headers case-insensitively for keys but preserves values", () => {
        const hook = new Hook({
            on: "user_message",
            do: `#!/bin/bash
echo "LECTIC:MiXeD:VaLuE"
echo "content"`,
            inline: true
        })
        
        const results = runHooks([hook], "user_message", {})
        expect(results).toHaveLength(1)
        expect(results[0].attributes).toEqual({
            mixed: "VaLuE"
        })
        expect(results[0].content.trim()).toBe("content")
    })

    it("stops parsing headers at first non-header non-blank line", () => {
        const hook = new Hook({
            on: "user_message",
            do: `#!/bin/bash
echo "LECTIC:A:1"
echo "not a header"
echo "LECTIC:B:2"`,
            inline: true
        })
        
        const results = runHooks([hook], "user_message", {})
        expect(results).toHaveLength(1)
        expect(results[0].attributes).toEqual({
            a: "1"
        })
        // The rest should be content
        expect(results[0].content.trim()).toBe("not a header\nLECTIC:B:2")
    })

    it("handles output that is only headers", () => {
        const hook = new Hook({
            on: "user_message",
            do: `#!/bin/bash
echo "LECTIC:ONLY:headers"`,
            inline: true
        })
        
        const results = runHooks([hook], "user_message", {})
        expect(results).toHaveLength(1)
        expect(results[0].attributes).toEqual({
            only: "headers"
        })
        expect(results[0].content.trim()).toBe("")
    })

    it("ignores headers if they appear later in the content", () => {
        const hook = new Hook({
            on: "user_message",
            do: `#!/bin/bash
echo "content first"
echo ""
echo "LECTIC:LATE:header"`,
            inline: true
        })
        
        const results = runHooks([hook], "user_message", {})
        expect(results).toHaveLength(1)
        expect(results[0].attributes).toBeUndefined()
        expect(results[0].content).toContain("LECTIC:LATE:header")
    })
})

describe("emitAssistantMessageEvent", () => {
    it("includes usage stats in environment variables", () => {
        const hook = new Hook({
            on: "assistant_message",
            do: `#!/bin/bash
echo "USAGE:\${TOKEN_USAGE_INPUT}:\${TOKEN_USAGE_CACHED}:\${TOKEN_USAGE_OUTPUT}:\${TOKEN_USAGE_TOTAL}"`,
            inline: true
        })

        const mockLectic = {
            header: {
                interlocutor: { name: "TestBot" },
                hooks: [hook]
            },
            body: {
                snapshot: () => "mock snapshot"
            }
        } as any

        const results = emitAssistantMessageEvent("some response", mockLectic, {
            usage: { input: 10, cached: 15, output: 20, total: 30 }
        })

        expect(results).toHaveLength(1)
        expect(results[0].content.trim()).toBe("USAGE:10:15:20:30")
    })
})

describe("resolveToolCalls with tool_use_pre hook", () => {

    class MockTool extends Tool {
        required: string[] = []
        name = "mock_tool"
        description = "A mock tool"
        parameters = {}
        async call(_args: any) {
            return ToolCallResults("mock result")
        }
    }

    const registry = { "mock_tool": new MockTool() }

    it("allows tool call when hook passes (exit code 0)", async () => {
        const hook = new Hook({
            on: "tool_use_pre",
            do: "#!/bin/bash\nexit 0"
        })
        const lectic = { header : { hooks: [hook], interlocutor: {} } }
        const entries = [{ name: "mock_tool", args: {} }]
        const results = await resolveToolCalls(entries, registry, { lectic : lectic as any })
        
        expect(results[0].isError).toBe(false)
        expect(results[0].results[0].content).toBe("mock result")
    })

    it("blocks tool call when hook fails (exit code 1)", async () => {
        const hook = new Hook({
            on: "tool_use_pre",
            do: "#!/bin/bash\nexit 1"
        })
        const lectic = { header : { hooks: [hook], interlocutor: {} } }
        const entries = [{ name: "mock_tool", args: {} }]
        const results = await resolveToolCalls(entries, registry, { lectic : lectic as any })
        
        expect(results[0].isError).toBe(true)
        expect(results[0].results[0].content).toBe("Tool use permission denied")
    })

    it("passes tool name and args to hook", async () => {
        const hook = new Hook({
            on: "tool_use_pre",
            do: `#!/bin/bash
            if [ "$TOOL_NAME" != "mock_tool" ]; then exit 1; fi
            if [ "$TOOL_ARGS" != '{"foo":"bar"}' ]; then exit 1; fi
            exit 0
            `
        })
        const lectic = { header : { hooks: [hook], interlocutor: {} } }
        const entries = [{ name: "mock_tool", args: { foo: "bar" } }]
        const results = await resolveToolCalls(entries, registry, { lectic : lectic as any })
        
        expect(results[0].isError).toBe(false)
    })
})
