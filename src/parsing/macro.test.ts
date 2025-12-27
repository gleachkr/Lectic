import { describe, expect, test } from "bun:test"
import { expandMacros } from "./macro"
import { Macro } from "../types/macro"

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
})
