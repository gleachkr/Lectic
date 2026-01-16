import { describe, expect, test } from "bun:test"
import { expandMacros } from "./macro"
import { Macro } from "../types/macro"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

describe("expandMacros", () => {
    test("expands simple macro", async () => {
        const macros = {
            hello: new Macro({ name: "hello", expansion: "Hello World" })
        }
        const input = ":hello[]"
        const output = await expandMacros(input, macros)
        expect(output.trim()).toBe("Hello World")
    })

    test("passes ARG to expansion", async () => {
        const macros = {
            greet: new Macro({ 
                name: "greet", 
                expansion: "exec:echo Hello $ARG"
            })
        }
        const input = ":greet[World]"
        const output = await expandMacros(input, macros)
        expect(output.trim()).toBe("Hello World")
    })

    test("pre phase short-circuits recursion", async () => {
        const macros = {
            short: new Macro({
                name: "short",
                pre: "Short Circuit",
                expansion: "Should Not See This"
            }),
            inner: new Macro({
                name: "inner",
                expansion: "Inner Expansion"
            })
        }
        const input = ":short[:inner[]]"
        const output = await expandMacros(input, macros)
        // Pre returns "Short Circuit", inner is never expanded
        expect(output.trim()).toBe("Short Circuit")
    })

    test("pre phase recursion on result", async () => {
        const macros = {
            wrapper: new Macro({
                name: "wrapper",
                pre: ":inner[]" 
            }),
            inner: new Macro({
                name: "inner",
                expansion: "Expanded Content"
            })
        }
        const input = ":wrapper[]"
        const output = await expandMacros(input, macros)
        expect(output.trim()).toBe("Expanded Content")
    })

    test("pre phase empty string falls through", async () => {
        const macros = {
            check: new Macro({
                name: "check",
                pre: "", // Fallthrough
                post: "Checked: $ARG"
            }),
            inner: new Macro({
                name: "inner",
                expansion: "Content"
            })
        }
        const input = ":check[:inner[]]"
        const output = await expandMacros(input, macros)
        // Pre falls through -> Inner expands to "Content" -> Post runs
        expect(output.trim()).toBe("Checked: Content")
    })

    test("explicit delete with comment", async () => {
        const macros = {
            delete: new Macro({
                name: "delete",
                pre: "<!-- -->",
                expansion: "Should not see"
            }),
            inner: new Macro({
                name: "inner",
                expansion: "Should not run"
            })
        }
        const input = "Start :delete[:inner[]] End"
        const output = await expandMacros(input, macros)
        // The comment is preserved in the AST/Markdown source
        expect(output.replace(/\s+/g, ' ').trim()).toBe("Start <!-- --> End")
    })

    test("recursive structure (cache pattern)", async () => {
        // Simulate cache hit
        const hitMacros = {
            cache: new Macro({
                name: "cache",
                pre: "Cached Result",
                post: "Should not run"
            }),
            expensive: new Macro({
                name: "expensive",
                expansion: "Expensive Result"
            })
        }
        expect((await expandMacros(":cache[:expensive[]]", hitMacros)).trim())
            .toBe("Cached Result")

        // Simulate cache miss
        const missMacros = {
            cache: new Macro({
                name: "cache",
                pre: "", // Miss
                post: "Cached: $ARG"
            }),
            expensive: new Macro({
                name: "expensive",
                expansion: "Expensive Result"
            })
        }
        expect((await expandMacros(":cache[:expensive[]]", missMacros)).trim())
            .toBe("Cached: Expensive Result")
    })
    
    test("ARG in pre is raw source", async () => {
         const macros = {
            inspect: new Macro({
                name: "inspect",
                pre: "Raw: $ARG",
            }),
            inner: new Macro({ name: "inner", expansion: "Expanded" })
        }
        // When pre runs, children are not expanded yet
        // However, the result of pre IS recursively expanded.
        const input = ":inspect[:inner[]]"
        const output = await expandMacros(input, macros)
        expect(output.trim()).toBe("Raw: Expanded")
    })

    test("nested conditional", async () => {
        const macros = {
            if_a: new Macro({
                name: "if_a",
                pre: ":case_a[]"
            }),
            case_a: new Macro({
                name: "case_a",
                expansion: "Case A"
            }),
            case_b: new Macro({
                name: "case_b",
                expansion: "Case B"
            })
        }
        const input = ":if_a[:case_b[]]" // inner should not run
        const output = await expandMacros(input, macros)
        expect(output.trim()).toBe("Case A")
    })

    test("builtin :env reads from process.env", async () => {
        const prev = process.env["LECTIC_TEST_ENV"]
        process.env["LECTIC_TEST_ENV"] = "hello"
        try {
            const out = await expandMacros(":env[LECTIC_TEST_ENV]", {})
            expect(out).toBe("hello")
        } finally {
            if (prev === undefined) delete process.env["LECTIC_TEST_ENV"]
            else process.env["LECTIC_TEST_ENV"] = prev
        }
    })

    test("builtin :env reads from directive attrs", async () => {
        const out = await expandMacros(":env[FOO]{FOO=\"bar\"}", {})
        expect(out).toBe("bar")
    })

    test("builtin :verbatim returns raw child text", async () => {
        const macros = {
            inner: new Macro({ name: "inner", expansion: "EXPANDED" }),
        }
        const out = await expandMacros(":verbatim[:inner[]]", macros)
        expect(out.trim()).toBe(":inner[]")
    })

    test("builtin :once only expands in final message", async () => {
        const macros = {
            inner: new Macro({ name: "inner", expansion: "EXPANDED" }),
        }

        const notFinal = await expandMacros(
            ":once[:inner[]]",
            macros,
            { MESSAGE_INDEX: 1, MESSAGES_LENGTH: 2 }
        )
        expect(notFinal).toBe("")

        const final = await expandMacros(
            ":once[:inner[]]",
            macros,
            { MESSAGE_INDEX: 2, MESSAGES_LENGTH: 2 }
        )
        expect(final.trim()).toBe("EXPANDED")
    })

    test("builtin :discard evaluates children but discards output", async () => {
        const dir = mkdtempSync(join(tmpdir(), "lectic-macro-"))
        const outFile = join(dir, "clear-test.txt")

        try {
            const out = await expandMacros(
                `:discard[:cmd[echo hi > \"${outFile}\"]]`,
                {},
                { MESSAGE_INDEX: 1, MESSAGES_LENGTH: 1 }
            )

            expect(out).toBe("")
            expect(existsSync(outFile)).toBe(true)
            expect(readFileSync(outFile, "utf8").trim()).toBe("hi")
        } finally {
            rmSync(dir, { recursive: true, force: true })
        }
    })
})
