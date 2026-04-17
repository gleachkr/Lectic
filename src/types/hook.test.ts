import { describe, expect, test } from "bun:test"
import { Hook, getActiveHooks, validateHookSpec } from "./hook"

describe("Hook", () => {
    test("validates spec", () => {
        expect(() => new Hook({ on: "user_message", do: "echo 'hello'" })).not.toThrow()
        expect(() => new Hook({ on: "run_start", do: "echo 'start'" })).not.toThrow()
        expect(() => new Hook({ on: "run_end", do: "echo 'end'" })).not.toThrow()
        expect(() => new Hook({ on: "tool_use_post", do: "echo 'post'" })).not.toThrow()
        expect(() => new Hook({ on: "assistant_final", do: "echo 'final'" })).not.toThrow()
        expect(() => new Hook({ on: "assistant_intermediate", do: "echo 'mid'" })).not.toThrow()
        expect(() => new Hook({ on: "user_first", do: "echo 'first'" })).not.toThrow()
        expect(() => new Hook({
            on: "assistant_message",
            do: "echo 'icon'",
            icon: "🔎",
        })).not.toThrow()
        expect(() => new Hook({
            on: "assistant_message",
            do: "echo 'best effort'",
            allow_failure: true,
        })).not.toThrow()
        expect(() => new Hook({
            on: "tool_use_post",
            do: "echo 'background'",
            async: true,
        })).not.toThrow()
        expect(() => new Hook({
            on: "assistant_message",
            do: "echo 'comment'",
            inline_as: "comment",
        })).not.toThrow()
    })

    test("rejects non-string icons", () => {
        expect(() => validateHookSpec({
            on: "assistant_message",
            do: "echo 'icon'",
            icon: 1,
        })).toThrow('The "icon" field of a hook must be a string.')
    })

    test("rejects invalid inline_as", () => {
        expect(() => validateHookSpec({
            on: "assistant_message",
            do: "echo 'x'",
            inline_as: "xml",
        })).toThrow(
            'The "inline_as" field of a hook must be "attachment" ' +
            'or "comment".'
        )
    })

    test("rejects non-boolean allow_failure", () => {
        expect(() => validateHookSpec({
            on: "assistant_message",
            do: "echo 'x'",
            allow_failure: "yes",
        })).toThrow('The "allow_failure" field of a hook must be a boolean.')
    })

    test("rejects non-boolean async", () => {
        expect(() => validateHookSpec({
            on: "assistant_message",
            do: "echo 'x'",
            async: "yes",
        })).toThrow('The "async" field of a hook must be a boolean.')
    })

    test("rejects async inline hooks", () => {
        expect(() => validateHookSpec({
            on: "assistant_message",
            do: "echo 'x'",
            inline: true,
            async: true,
        })).toThrow('Async hooks can\'t set "inline: true".')
    })

    test("execute single line", () => {
        const h = new Hook({ on: "user_message", do: "echo 'hello'", inline: true })
        const { output } = h.execute()
        expect((output as string).trim()).toBe("hello")
    })

    test("execute multi line", () => {
        const h = new Hook({ on: "user_message", do: "#!/bin/bash\necho 'hello'\necho 'world'", inline: true })
        const { output } = h.execute()
        expect((output as string).trim()).toBe("hello\nworld")
    })

    test("execute with env", () => {
        const h = new Hook({ on: "user_message", do: "echo $FOO", inline: true })
        const { output } = h.execute({ FOO: "bar" })
        expect((output as string).trim()).toBe("bar")
    })

    test("execute returns exit code", () => {
        const h = new Hook({ on: "tool_use_pre", do: "#!/bin/bash\nexit 1" })
        const { exitCode } = h.execute()
        expect(exitCode).toBe(1)
    })
})

describe("getActiveHooks", () => {
    test("user_message dispatches user_first when MESSAGES_LENGTH is 1", () => {
        const userHook = new Hook({ on: "user_message", do: "echo user" })
        const firstHook = new Hook({ on: "user_first", do: "echo first" })
        const hooks = [userHook, firstHook]

        const active = getActiveHooks(hooks, "user_message", { MESSAGES_LENGTH: "1" })
        expect(active).toEqual([userHook, firstHook])
    })

    test("user_message does not dispatch user_first when MESSAGES_LENGTH > 1", () => {
        const userHook = new Hook({ on: "user_message", do: "echo user" })
        const firstHook = new Hook({ on: "user_first", do: "echo first" })
        const hooks = [userHook, firstHook]

        const active = getActiveHooks(hooks, "user_message", { MESSAGES_LENGTH: "3" })
        expect(active).toEqual([userHook])
    })

    test("assistant_message dispatches assistant_final when TOOL_USE_DONE", () => {
        const msgHook = new Hook({ on: "assistant_message", do: "echo msg" })
        const finalHook = new Hook({ on: "assistant_final", do: "echo final" })
        const midHook = new Hook({ on: "assistant_intermediate", do: "echo mid" })
        const hooks = [msgHook, finalHook, midHook]

        const active = getActiveHooks(hooks, "assistant_message", { TOOL_USE_DONE: "1" })
        expect(active).toEqual([msgHook, finalHook])
    })

    test("assistant_message dispatches assistant_intermediate when not TOOL_USE_DONE", () => {
        const msgHook = new Hook({ on: "assistant_message", do: "echo msg" })
        const finalHook = new Hook({ on: "assistant_final", do: "echo final" })
        const midHook = new Hook({ on: "assistant_intermediate", do: "echo mid" })
        const hooks = [msgHook, finalHook, midHook]

        const active = getActiveHooks(hooks, "assistant_message", { TOOL_USE_DONE: "0" })
        expect(active).toEqual([msgHook, midHook])
    })

    test("run_end dispatches error alias when RUN_STATUS is error", () => {
        const endHook = new Hook({ on: "run_end", do: "echo end" })
        const errHook = new Hook({ on: "error", do: "echo err" })
        const hooks = [endHook, errHook]

        const active = getActiveHooks(hooks, "run_end", { RUN_STATUS: "error" })
        expect(active).toEqual([endHook, errHook])
    })

    test("run_end does not dispatch error alias on success", () => {
        const endHook = new Hook({ on: "run_end", do: "echo end" })
        const errHook = new Hook({ on: "error", do: "echo err" })
        const hooks = [endHook, errHook]

        const active = getActiveHooks(hooks, "run_end", { RUN_STATUS: "success" })
        expect(active).toEqual([endHook])
    })
})
