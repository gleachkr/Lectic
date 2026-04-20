import { describe, it, expect } from "bun:test"
import { existsSync, unlinkSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import {
    Backend,
    emitAssistantMessageEvent,
    HookExecutionTracker,
    resolveToolCalls,
    runHooks,
} from "../types/backend"
import { Hook } from "../types/hook"
import {
    serializeCall,
    Tool,
    ToolCallResults,
} from "../types/tool"
import { AssistantMessage, UserMessage } from "../types/message"
import {
    getProviderInlineAttachment,
    serializeInlineAttachment,
    serializeInlineRecord,
    type InlineAttachment,
    type InlineRecord,
} from "../types/inlineAttachment"
import { serializeThoughtBlock } from "../types/thought"
import { wrapForeignAssistantMessage } from "./common"
import { LLMProvider } from "../types/provider"

function expectAttachment(record: InlineRecord): InlineAttachment {
    expect(record.kind).toBe("attachment")
    const attachment = getProviderInlineAttachment(record)
    expect(attachment).not.toBeNull()
    return attachment as InlineAttachment
}

async function waitForFile(path: string, timeoutMs = 1000): Promise<string> {
    const startedAt = Date.now()
    while (Date.now() - startedAt < timeoutMs) {
        if (existsSync(path)) {
            return Bun.file(path).text()
        }
        await Bun.sleep(25)
    }
    throw new Error(`Timed out waiting for ${path}`)
}

describe("wrapForeignAssistantMessage", () => {
    it("keeps only assistant prose for wrapped foreign messages", () => {
        const tool: Tool = {
            name: "echo",
            description: "echo tool",
            parameters: {
                s: { type: "string", description: "text" },
            },
            required: [],
            kind: "mock",
            hooks: [],
            call: async (_args) => ToolCallResults("ok"),
            validateArguments: _ => null,
        }

        const attachment = serializeInlineAttachment({
            kind: "attach",
            command: "echo context",
            content: "attached context",
        })
        const thought = serializeThoughtBlock({
            provider: "openai",
            content: ["private reasoning"],
        })
        const call = serializeCall(tool, {
            name: "echo",
            args: { s: "hi" },
            results: ToolCallResults("done"),
        })
        const msg = new AssistantMessage({
            content: [
                "before <!-- hidden --> text",
                "",
                attachment,
                "",
                thought,
                "",
                call,
                "",
                "after",
            ].join("\n"),
            interlocutor: {
                name: "Other",
                prompt: "",
                registry: { echo: tool },
            } as any,
        })

        expect(wrapForeignAssistantMessage(msg)).toBe(
            '<speaker name="Other">before <!-- hidden --> text\n\n' +
            'after</speaker>'
        )
    })
})

describe("runHooks", () => {
    it("handles simple text output without headers", () => {
        const hook = new Hook({
            on: "user_message",
            do: "echo 'hello world'",
            inline: true
        })
        
        const results = runHooks([hook], "user_message", {})
        expect(results).toHaveLength(1)
        const attachment = expectAttachment(results[0])
        expect(attachment.content.trim()).toBe("hello world")
        expect(attachment.attributes).toBeUndefined()
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
        const attachment = expectAttachment(results[0])
        expect(attachment.attributes).toEqual({
            ctx: "reset",
            foo: "bar"
        })
        expect(attachment.content.trim()).toBe("actual content")
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
        const attachment = expectAttachment(results[0])
        expect(attachment.attributes).toEqual({
            final: "true"
        })
        expect(attachment.content.trim()).toBe("content")
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
        const attachment = expectAttachment(results[0])
        expect(attachment.attributes).toEqual({
            mixed: "VaLuE"
        })
        expect(attachment.content.trim()).toBe("content")
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
        const attachment = expectAttachment(results[0])
        expect(attachment.attributes).toEqual({
            a: "1"
        })
        // The rest should be content
        expect(attachment.content.trim()).toBe("not a header\nLECTIC:B:2")
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
        const attachment = expectAttachment(results[0])
        expect(attachment.attributes).toEqual({
            only: "headers"
        })
        expect(attachment.content.trim()).toBe("")
    })

    it("adds hook name and icon metadata to inline attachments", () => {
        const hook = new Hook({
            on: "user_message",
            do: "echo 'content'",
            inline: true,
            name: "audit",
            icon: "🔎",
        })

        const results = runHooks([hook], "user_message", {})
        expect(results).toHaveLength(1)
        const attachment = expectAttachment(results[0])
        expect(attachment.icon).toBe("🔎")
        expect(attachment.attributes).toEqual({
            name: "audit",
        })
    })

    it("can record inline hook output as a markdown comment", () => {
        const hook = new Hook({
            on: "user_message",
            do: "echo 'hidden log -- detail'",
            inline: true,
            inline_as: "comment",
        })

        const results = runHooks([hook], "user_message", {})
        expect(results).toHaveLength(1)
        expect(results[0]).toEqual({
            kind: "comment",
            content: "hidden log -- detail\n",
        })
        expect(serializeInlineRecord(results[0])).toBe(
            "<!--\nhidden log -- detail\n\n-->"
        )
    })

    it("escapes literal comment close markers in comment mode", () => {
        const hook = new Hook({
            on: "user_message",
            do: "echo 'hidden --> detail'",
            inline: true,
            inline_as: "comment",
        })

        const results = runHooks([hook], "user_message", {})
        expect(results).toHaveLength(1)
        expect(serializeInlineRecord(results[0])).toBe(
            "<!--\nhidden -- > detail\n\n-->"
        )
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
        expect(expectAttachment(results[0]).content.trim()).toBe("done")
    })

    it("runs assistant_intermediate when TOOL_USE_DONE is not set", () => {
        const hook = new Hook({
            on: "assistant_intermediate",
            do: "echo 'working'",
            inline: true,
        })

        const results = runHooks([hook], "assistant_message", {})

        expect(results).toHaveLength(1)
        expect(expectAttachment(results[0]).content.trim()).toBe("working")
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
        expect(expectAttachment(results[0]).content.trim()).toBe("base")
        expect(expectAttachment(results[1]).content.trim()).toBe("alias")
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
        expect(expectAttachment(results[0]).content.trim()).toBe("base")
        expect(expectAttachment(results[1]).content.trim()).toBe("boom")
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
        const attachment = expectAttachment(results[0])
        expect(attachment.attributes).toBeUndefined()
        expect(attachment.content).toContain("LECTIC:LATE:header")
    })

    it("throws when a hook exits non-zero", () => {
        const hook = new Hook({
            on: "user_message",
            do: "#!/bin/bash\necho fail >&2\nexit 7",
            inline: true,
        })

        expect(() => runHooks([hook], "user_message", {})).toThrow(
            "Hook \"#!/bin/bash\" failed for user_message with exit code 7"
        )
    })

    it("allows a failing hook when allow_failure is true", () => {
        const hook = new Hook({
            on: "user_message",
            do: "#!/bin/bash\necho ignored >&2\nexit 7",
            inline: true,
            allow_failure: true,
        })

        const results = runHooks([hook], "user_message", {})
        expect(results).toHaveLength(0)
    })

    it("starts background hooks without waiting for completion", async () => {
        const out = join(
            tmpdir(),
            `lectic-background-hook-${Date.now()}-${Math.random()}.txt`
        )
        const hook = new Hook({
            on: "run_end",
            mode: "background",
            env: { OUT: out },
            do: "#!/bin/bash\nsleep 0.3\nprintf 'done' > \"$OUT\"",
        })

        const startedAt = Date.now()
        const results = runHooks([hook], "run_end", { RUN_STATUS: "success" })
        const elapsedMs = Date.now() - startedAt

        expect(results).toHaveLength(0)
        expect(elapsedMs).toBeLessThan(250)
        expect(existsSync(out)).toBe(false)

        const written = await waitForFile(out)
        try { unlinkSync(out) } catch { /* ignore */ }
        expect(written).toBe("done")
    })

    it("does not wait for detached hooks when draining", async () => {
        const out = join(
            tmpdir(),
            `lectic-detached-hook-${Date.now()}-${Math.random()}.txt`
        )
        const hook = new Hook({
            on: "run_end",
            mode: "detached",
            env: { OUT: out },
            do: [
                "#!/bin/bash",
                "sleep 0.3",
                "printf 'done' > \"$OUT\"",
                "rm -- \"$0\"",
            ].join("\n"),
        })
        const runner = new HookExecutionTracker()

        const startedAt = Date.now()
        const results = runHooks(
            [hook],
            "run_end",
            { RUN_STATUS: "success" },
            undefined,
            runner,
        )
        await runner.drain()
        const elapsedMs = Date.now() - startedAt

        expect(results).toHaveLength(0)
        expect(elapsedMs).toBeLessThan(250)
        expect(existsSync(out)).toBe(false)

        const written = await waitForFile(out)
        try { unlinkSync(out) } catch { /* ignore */ }
        expect(written).toBe("done")
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
        expect(expectAttachment(results[0]).content.trim()).toBe(
            "USAGE:10:15:20:30"
        )
    })
})

describe("comment-mode inline hooks during evaluate", () => {
    class MockLoopBackend extends Backend<
        { role: string, text: string, inlineAttachments?: InlineAttachment[] },
        { text: string }
    > {
        provider = LLMProvider.Anthropic
        defaultModel = "mock-model"
        seenInlinePreface: InlineAttachment[][] = []
        createCalls = 0

        constructor(private readonly replyText: string) {
            super()
        }

        async listModels(): Promise<string[]> {
            return []
        }

        protected async handleMessage(msg: any, _lectic: any, opt?: {
            inlineAttachments?: InlineAttachment[]
        }) {
            if (msg.role === "user") {
                this.seenInlinePreface.push(opt?.inlineAttachments ?? [])
            }

            return {
                messages: [{
                    role: msg.role,
                    text: msg.content,
                    inlineAttachments: opt?.inlineAttachments,
                }],
                reset: false,
            }
        }

        protected async createCompletion() {
            this.createCalls++
            const text = this.replyText
            return {
                chunks: (async function* () {
                    yield { kind: "text" as const, text }
                })(),
                final: Promise.resolve({ text }),
            }
        }

        protected finalHasToolCalls(): boolean {
            return false
        }

        protected finalUsage() {
            return undefined
        }

        protected applyReset(): void {
            throw new Error("unexpected reset")
        }

        protected appendAssistantMessage(messages: any[], final: { text: string }) {
            messages.push({ role: "assistant", text: final.text })
        }

        protected getToolCallEntries() {
            return []
        }

        protected async appendToolResults(): Promise<void> {
            throw new Error("unexpected tool results")
        }
    }

    it("does not pass user-message comment hooks to the provider", async () => {
        const hook = new Hook({
            on: "user_message",
            do: "echo 'log entry'",
            inline: true,
            inline_as: "comment",
        })
        const backend = new MockLoopBackend("hello")
        const lectic = {
            header: {
                hooks: [hook],
                interlocutor: {
                    name: "TestBot",
                    prompt: "",
                    model: "mock-model",
                    registry: {},
                },
            },
            body: {
                messages: [new UserMessage({ content: "hi" })],
                snapshot: () => "snapshot",
            },
        } as any

        let output = ""
        for await (const chunk of backend.evaluate(lectic)) {
            output += chunk
        }

        expect(backend.seenInlinePreface).toEqual([[]])
        expect(output).toContain("<!--\nlog entry\n\n-->")
        expect(output.indexOf("<!--")).toBeLessThan(output.indexOf("hello"))
    })

    it("does not trigger an extra assistant pass for comment hooks", async () => {
        const hook = new Hook({
            on: "assistant_message",
            do: "echo 'log entry'",
            inline: true,
            inline_as: "comment",
        })
        const backend = new MockLoopBackend("hello")
        const lectic = {
            header: {
                hooks: [hook],
                interlocutor: {
                    name: "TestBot",
                    prompt: "",
                    model: "mock-model",
                    registry: {},
                },
            },
            body: {
                messages: [new UserMessage({ content: "hi" })],
                snapshot: () => "snapshot",
            },
        } as any

        let output = ""
        for await (const chunk of backend.evaluate(lectic)) {
            output += chunk
        }

        expect(backend.createCalls).toBe(1)
        expect(output).toContain("hello")
        expect(output).toContain("<!--\nlog entry\n\n-->")
        expect(output.indexOf("hello")).toBeLessThan(output.indexOf("<!--"))
    })

    it("tracks background assistant hooks with the shared hook runner", async () => {
        const out = join(
            tmpdir(),
            `lectic-assistant-background-${Date.now()}-${Math.random()}.txt`
        )
        const hook = new Hook({
            on: "assistant_message",
            mode: "background",
            env: { OUT: out },
            do: "#!/bin/bash\nsleep 0.3\nprintf '%s' \"$ASSISTANT_MESSAGE\" > \"$OUT\"",
        })
        const backend = new MockLoopBackend("hello")
        const lectic = {
            header: {
                hooks: [hook],
                interlocutor: {
                    name: "TestBot",
                    prompt: "",
                    model: "mock-model",
                    registry: {},
                },
            },
            body: {
                messages: [new UserMessage({ content: "hi" })],
                snapshot: () => "snapshot",
            },
        } as any
        const runner = new HookExecutionTracker()

        for await (const _chunk of backend.evaluate(lectic, { hookRunner: runner })) {
            // drain the iterator
        }

        expect(existsSync(out)).toBe(false)

        await runner.drain()

        const written = await waitForFile(out)
        try { unlinkSync(out) } catch { /* ignore */ }
        expect(written).toBe("hello")
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

    it("passes tool name, id, and args to pre hooks", async () => {
        const hook = new Hook({
            on: "tool_use_pre",
            do: `#!/bin/bash
            if [ "$TOOL_CALL_ID" != "call-123" ]; then exit 1; fi
            if [ "$TOOL_NAME" != "mock_tool" ]; then exit 1; fi
            if [ "$TOOL_ARGS" != '{"foo":"bar"}' ]; then exit 1; fi
            exit 0
            `
        })
        const lectic = { header : { hooks: [hook], interlocutor: {} } }
        const entries = [{
            id: "call-123",
            name: "mock_tool",
            args: { foo: "bar" },
        }]
        const results = await resolveToolCalls(entries, registry, { lectic : lectic as any })
        
        expect(results[0].isError).toBe(false)
    })

    it("allows failing tool_use_pre hook when allow_failure is true", async () => {
        const hook = new Hook({
            on: "tool_use_pre",
            do: "#!/bin/bash\nexit 1",
            allow_failure: true,
        })
        const lectic = { header : { hooks: [hook], interlocutor: {} } }
        const entries = [{ name: "mock_tool", args: {} }]
        const results = await resolveToolCalls(entries, registry, {
            lectic: lectic as any,
        })

        expect(results[0].isError).toBe(false)
        expect(results[0].results[0].content).toBe("mock result")
    })

    it("does not wait for background tool_use_pre hooks", async () => {
        const out = join(
            tmpdir(),
            `lectic-tool-pre-background-${Date.now()}-${Math.random()}.txt`
        )
        const hook = new Hook({
            on: "tool_use_pre",
            mode: "background",
            allow_failure: true,
            env: { OUT: out },
            do: "#!/bin/bash\nsleep 0.3\nprintf '%s' \"$TOOL_NAME\" > \"$OUT\"",
        })
        const lectic = { header : { hooks: [hook], interlocutor: {} } }
        const entries = [{ name: "mock_tool", args: {} }]

        const startedAt = Date.now()
        const results = await resolveToolCalls(entries, registry, {
            lectic: lectic as any,
        })
        const elapsedMs = Date.now() - startedAt

        expect(results[0].isError).toBe(false)
        expect(results[0].results[0].content).toBe("mock result")
        expect(elapsedMs).toBeLessThan(250)
        expect(existsSync(out)).toBe(false)

        const written = await waitForFile(out)
        try { unlinkSync(out) } catch { /* ignore */ }
        expect(written).toBe("mock_tool")
    })

    it("emits tool_use_post with TOOL_CALL_ID and results on success", async () => {
        const out = join(
            tmpdir(),
            `lectic-tool-post-success-${Date.now()}-${Math.random()}.txt`
        )

        const postHook = new Hook({
            on: "tool_use_post",
            do: "#!/bin/bash\nprintf '%s\n%s' \"$TOOL_CALL_ID\" \"$TOOL_CALL_RESULTS\" > \"$OUT\"",
            env: { OUT: out },
        })

        const lectic = {
            header: {
                hooks: [postHook],
                interlocutor: {},
            },
        }

        const entries = [{
            id: "call-xyz",
            name: "mock_tool",
            args: { foo: "bar" },
        }]
        const results = await resolveToolCalls(entries, registry, {
            lectic: lectic as any,
        })

        const written = await Bun.file(out).text()
        try { unlinkSync(out) } catch { /* ignore */ }

        expect(results[0].isError).toBe(false)
        expect(written).toContain('call-xyz')
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

    it("throws when a tool_use_post hook exits non-zero", async () => {
        const failingPostHook = new Hook({
            on: "tool_use_post",
            do: "#!/bin/bash\necho post-fail >&2\nexit 2",
        })

        const lectic = {
            header: {
                hooks: [failingPostHook],
                interlocutor: {},
            },
        }

        const entries = [{ name: "mock_tool", args: {} }]

        let error: unknown
        try {
            await resolveToolCalls(entries, registry, {
                lectic: lectic as any,
            })
        } catch (e) {
            error = e
        }

        expect(error).toBeInstanceOf(Error)
        expect((error as Error).message).toContain(
            'Hook "#!/bin/bash" failed for tool_use_post with exit code 2'
        )
    })

    it("allows failing tool_use_post hook when allow_failure is true", async () => {
        const failingPostHook = new Hook({
            on: "tool_use_post",
            do: "#!/bin/bash\nexit 2",
            allow_failure: true,
        })

        const lectic = {
            header: {
                hooks: [failingPostHook],
                interlocutor: {},
            },
        }

        const entries = [{ name: "mock_tool", args: {} }]
        const results = await resolveToolCalls(entries, registry, {
            lectic: lectic as any,
        })

        expect(results[0].isError).toBe(false)
        expect(results[0].results[0].content).toBe("mock result")
    })

    it("omits oversized TOOL_CALL_RESULTS and sets TOOL_CALL_WARNING", async () => {
        class LargeTool extends Tool {
            required: string[] = []
            name = "large_tool"
            description = "A large mock tool"
            parameters = {}
            kind = "mock"
            async call() {
                return ToolCallResults("x".repeat(100_000))
            }
        }

        const out = join(
            tmpdir(),
            `lectic-tool-post-large-${Date.now()}-${Math.random()}.txt`
        )
        const postHook = new Hook({
            on: "tool_use_post",
            env: { OUT: out },
            do: "#!/bin/bash\n" +
                "if [ -n \"$TOOL_CALL_RESULTS\" ]; then\n" +
                "  exit 9\n" +
                "fi\n" +
                "printf '%s' \"$TOOL_CALL_WARNING\" > \"$OUT\"",
        })

        const lectic = {
            header: {
                hooks: [postHook],
                interlocutor: {},
            },
        }

        const entries = [{ name: "large_tool", args: {} }]
        const results = await resolveToolCalls(entries, {
            large_tool: new LargeTool(),
        }, {
            lectic: lectic as any,
        })

        expect(results[0].isError).toBe(false)

        const written = await Bun.file(out).text()
        try { unlinkSync(out) } catch { /* ignore */ }

        expect(written).toContain("tool call results too large")
        expect(written).toContain("KiB")
    })
})
