import { describe, it, expect } from "bun:test"
import { unlinkSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import { emitAssistantMessageEvent, resolveToolCalls, runHooks } from "../types/backend"
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

    it("runs assistant_final when TOOL_USE_DONE is set", () => {
        const hook = new Hook({
            on: "assistant_final",
            do: "echo 'done'",
            inline: true,
        })

        const results = runHooks([hook], "assistant_message", {
            TOOL_USE_DONE: "1",
        })

        expect(results).toHaveLength(1)
        expect(results[0].content.trim()).toBe("done")
    })

    it("runs assistant_intermediate when TOOL_USE_DONE is not set", () => {
        const hook = new Hook({
            on: "assistant_intermediate",
            do: "echo 'working'",
            inline: true,
        })

        const results = runHooks([hook], "assistant_message", {})

        expect(results).toHaveLength(1)
        expect(results[0].content.trim()).toBe("working")
    })

    it("runs base assistant hook before assistant_final alias hooks", () => {
        const base = new Hook({
            on: "assistant_message",
            do: "echo 'base'",
            inline: true,
        })
        const alias = new Hook({
            on: "assistant_final",
            do: "echo 'alias'",
            inline: true,
        })

        const results = runHooks([base, alias], "assistant_message", {
            TOOL_USE_DONE: "1",
        })

        expect(results).toHaveLength(2)
        expect(results[0].content.trim()).toBe("base")
        expect(results[1].content.trim()).toBe("alias")
    })

    it("runs error hooks as aliases of run_end when status is error", () => {
        const base = new Hook({
            on: "run_end",
            do: "echo 'base'",
            inline: true,
        })
        const alias = new Hook({
            on: "error",
            do: "echo $ERROR_MESSAGE",
            inline: true,
        })

        const results = runHooks([base, alias], "run_end", {
            RUN_STATUS: "error",
            ERROR_MESSAGE: "boom",
        })

        expect(results).toHaveLength(2)
        expect(results[0].content.trim()).toBe("base")
        expect(results[1].content.trim()).toBe("boom")
    })

    it("does not run error aliases when run_end status is success", () => {
        const alias = new Hook({
            on: "error",
            do: "echo 'unexpected'",
            inline: true,
        })

        const results = runHooks([alias], "run_end", {
            RUN_STATUS: "success",
        })

        expect(results).toHaveLength(0)
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
        kind = "mock"
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

    it("emits tool_use_post with TOOL_CALL_RESULTS on success", async () => {
        const out = join(
            tmpdir(),
            `lectic-tool-post-success-${Date.now()}-${Math.random()}.txt`
        )

        const postHook = new Hook({
            on: "tool_use_post",
            do: "#!/bin/bash\nprintf '%s' \"$TOOL_CALL_RESULTS\" > \"$OUT\"",
            env: { OUT: out },
        })

        const lectic = {
            header: {
                hooks: [postHook],
                interlocutor: {},
            },
        }

        const entries = [{ name: "mock_tool", args: { foo: "bar" } }]
        const results = await resolveToolCalls(entries, registry, {
            lectic: lectic as any,
        })

        const written = await Bun.file(out).text()
        try { unlinkSync(out) } catch { /* ignore */ }

        expect(results[0].isError).toBe(false)
        expect(written).toContain('"mimetype":"text/plain"')
        expect(written).toContain('"content":"mock result"')
    })

    it("emits tool_use_post with TOOL_CALL_ERROR when blocked", async () => {
        const out = join(
            tmpdir(),
            `lectic-tool-post-error-${Date.now()}-${Math.random()}.txt`
        )

        const blockingHook = new Hook({
            on: "tool_use_pre",
            do: "#!/bin/bash\nexit 1",
        })
        const postHook = new Hook({
            on: "tool_use_post",
            do: "#!/bin/bash\nprintf '%s' \"$TOOL_CALL_ERROR\" > \"$OUT\"",
            env: { OUT: out },
        })

        const lectic = {
            header: {
                hooks: [blockingHook, postHook],
                interlocutor: {},
            },
        }

        const entries = [{ name: "mock_tool", args: {} }]
        const results = await resolveToolCalls(entries, registry, {
            lectic: lectic as any,
        })

        const written = await Bun.file(out).text()
        try { unlinkSync(out) } catch { /* ignore */ }

        expect(results[0].isError).toBe(true)
        expect(results[0].results[0].content).toBe("Tool use permission denied")
        expect(written).toContain('"type":"blocked"')
        expect(written).toContain('"message":"Tool use permission denied"')
    })
})
