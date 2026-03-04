import { describe, expect, test } from "bun:test"
import { Hook, validateHookSpec } from "./hook"

describe("Hook", () => {
    test("validates spec", () => {
        expect(() => new Hook({ on: "user_message", do: "echo 'hello'" })).not.toThrow()
        expect(() => new Hook({ on: "run_start", do: "echo 'start'" })).not.toThrow()
        expect(() => new Hook({ on: "run_end", do: "echo 'end'" })).not.toThrow()
        expect(() => new Hook({ on: "tool_use_post", do: "echo 'post'" })).not.toThrow()
        expect(() => new Hook({ on: "assistant_final", do: "echo 'final'" })).not.toThrow()
        expect(() => new Hook({ on: "assistant_intermediate", do: "echo 'mid'" })).not.toThrow()
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
    })

    test("rejects non-string icons", () => {
        expect(() => validateHookSpec({
            on: "assistant_message",
            do: "echo 'icon'",
            icon: 1,
        })).toThrow('The "icon" field of a hook must be a string.')
    })

    test("rejects non-boolean allow_failure", () => {
        expect(() => validateHookSpec({
            on: "assistant_message",
            do: "echo 'x'",
            allow_failure: "yes",
        })).toThrow('The "allow_failure" field of a hook must be a boolean.')
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
