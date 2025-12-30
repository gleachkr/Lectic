import { describe, expect, test } from "bun:test"
import { expandMacros } from "./macro"
import { Macro } from "../types/macro"

describe("control flow macros", () => {
    test("conditional (if/else)", async () => {
        const macros = {
            if: new Macro({
                name: "if",
                pre: `exec:#!/bin/bash
if [ "$CONDITION" = "true" ]; then
    echo "$ARG"
else
    echo "$ELSE"
fi`
            })
        }
        
        const input1 = ':if[Yes]{CONDITION="true" ELSE="No"}'
        const output1 = await expandMacros(input1, macros)
        expect(output1.trim()).toBe("Yes")

        const input2 = ':if[Yes]{CONDITION="false" ELSE="No"}'
        const output2 = await expandMacros(input2, macros)
        expect(output2.trim()).toBe("No")
    })

    test("loop (counter)", async () => {
        const macros = {
            count: new Macro({
                name: "count",
                pre: `exec:#!/bin/bash
curr=\${CURRENT:-0}
max=\${MAX:-3}

if [ "$curr" -lt "$max" ]; then
    echo "$curr"
    next=$((curr + 1))
    echo ":count[]{CURRENT=$next MAX=$max}"
else
    echo "<!-- -->"
fi`
            })
        }
        
        const input = ":count[]{MAX=3}"
        const output = await expandMacros(input, macros)
        // Output will have newlines and potentially the comment
        // Filter out the comment parts for cleaner verification
        const lines = output.trim().split(/\s+/).filter(x => x !== "<!--" && x !== "-->")
        expect(lines).toEqual(["0", "1", "2"])
    })
    
    test("map (apply macro to list)", async () => {
        const macros = {
            wrap: new Macro({
                name: "wrap",
                expansion: "($ARG)"
            }),
            map: new Macro({
                name: "map",
                pre: `exec:#!/bin/bash
# Split by space for simplicity in this test
items=($ARG)
# Check if array is empty
if [ \${#items[@]} -eq 0 ]; then
    echo "<!-- -->"
    exit 0
fi

first=\${items[0]}
# slice from index 1 to end
rest=\${items[@]:1}

echo ":$MACRO[$first]"

if [ -n "$rest" ]; then
   echo ":map[$rest]{MACRO=$MACRO}"
fi
`
            })
        }
        
        const input = ':map[a b c]{MACRO="wrap"}'
        const output = await expandMacros(input, macros)
        expect(output.replace(/\s+/g, '')).toBe("(a)(b)(c)")
    })

    test("countdown (recursion with termination)", async () => {
        const macros = {
            countdown: new Macro({
                name: "countdown",
                pre: `exec:#!/bin/bash
N=\${ARG:-10}
if [ "$N" -gt 0 ]; then
    echo "$N..."
    echo ":countdown[$((N-1))]"
else
    echo "Liftoff!"
fi`
            })
        }
        
        const input = ":countdown[3]"
        const output = await expandMacros(input, macros)
        // Expected: 3...\n2...\n1...\nLiftoff!
        const lines = output.trim().split(/\s+/)
        expect(lines).toEqual(["3...", "2...", "1...", "Liftoff!"])
    })
})
