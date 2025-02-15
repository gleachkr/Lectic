import { expect, test } from "bun:test"
import { getYaml, getBody, splitBodyChunks, parseLectic } from "./parse"
import type { Lectic } from "./types/lectic"
import { Message } from "./types/message"

function template(header: string, body: string) : string {
return (
`---
${header}
---
${body}`
)}

const header1 = 
`AAA
BBB
DDD`

const body1 = 
`

CCC
EEE
`

const body2 = `

::: BOB
HI
:::

HULLO

::: BOB
HOW ARE YOU
:::
`

const ex1 = template(header1, body1)
const ex2 = template(header1, body2)

test("getYaml-ex1", () => {
  expect(getYaml(ex1)).toBe("AAA\nBBB\nDDD");
});

test("getBody-ex1", () => {
  expect(getBody(ex1)).toBe("\n\n\nCCC\nEEE\n");
});

test("splitBodyChunks-ex2", () => {
  expect(splitBodyChunks(getBody(ex2) ?? "")).toEqual([
      "::: BOB\nHI\n:::","HULLO","::: BOB\nHOW ARE YOU\n:::"]);
})

test("getYaml-empty", () => {
  expect(getYaml("")).toBe(null);
});

test("getBody-empty", () => {
  expect(getBody("")).toBe(null);
});

test("getYaml-malformed", () => {
  expect(getYaml("---\nMALFORMED")).toBe(null);
});

test("getBody-only", () => {
  const bodyOnly = `
  Something that looks like a header
  Still part of the body
  `;
  expect(getBody(bodyOnly)).toBe(null);
});

test("splitBodyChunks-variedBlocks", () => {
  const variedInput = `
::: Block1
Content A
:::
Interlude Text
::: Block2
Content B
:::
::: Block3
Content C
:::
  `;
  expect(splitBodyChunks(variedInput)).toEqual([
      "::: Block1\nContent A\n:::", "Interlude Text", "::: Block2\nContent B\n:::", "::: Block3\nContent C\n:::"]);
});

test("splitBodyChunks-noBody", () => {
  expect(splitBodyChunks("")).toEqual([]);
});

test("getYaml-headerOnly", () => {
  const headerOnly = `---
Header only
---`;
  expect(getYaml(headerOnly)).toBe("Header only");
});

test("getBody-complex", () => {
  const complexBody = `---
Header
---
Body with --- inside
Still part of body
---End of body`;
  expect(getBody(complexBody)).toBe("\nBody with --- inside\nStill part of body\n---End of body");
});

test("splitBodyChunks-withoutDividers", () => {
  const noDividers = `Regular content without dividers`;
  expect(splitBodyChunks(noDividers)).toEqual(["Regular content without dividers"]);
});

test("getYaml-noHeaderEmptyBody", () => {
  const noHeader = `
Exactly no yaml here
Still part of the text block`;
  expect(getYaml(noHeader)).toBe(null);
});

test("splitBodyChunks-multipleLines", () => {
  const multipleLines = `
::: Start
Line 1
Line 2
:::
Between blocks
::: Next
Line 3
Line 4
:::`;
  expect(splitBodyChunks(multipleLines)).toEqual([
    "::: Start\nLine 1\nLine 2\n:::", "Between blocks", "::: Next\nLine 3\nLine 4\n:::"
  ]);
});

test("getYaml-multilineComplex", () => {
  const multiline = `---
key1: value1
section:
  part1: a
  part2: b
---
Content`;
  expect(getYaml(multiline)).toBe("key1: value1\nsection:\n  part1: a\n  part2: b");
});

test("splitBodyChunks-noInitialDivider", () => {
  const withoutDivider = `No initial ::: divider
And more text
::: Marker
Finally a break
:::`;
  expect(splitBodyChunks(withoutDivider)).toEqual([
    "No initial ::: divider\nAnd more text", "::: Marker\nFinally a break\n:::"
  ]);
});

test("getBody-misplacedYamlDelimiters", () => {
  const misplacedDelimiters = `
---
Header
---
Body text starts
---
Another section
---Ends here`;
  expect(getBody(misplacedDelimiters)).toBe("\nBody text starts\n---\nAnother section\n---Ends here");
});
      
test("getYaml-nestedDelimiters", () => {
  const nested = `---
Header
---
---
Body
---`;
  expect(getYaml(nested)).toBe("Header");
});

test("splitBodyChunks-minimalContent", () => {
  const minimalContent = `
::: Marker
:::
`;
  expect(splitBodyChunks(minimalContent)).toEqual([
    "::: Marker\n:::"
  ]);
});

test("getBody-dividersOnly", () => {
  const noBodyContent = `
---
Header
---
:::
:::
`;

  expect(getBody(noBodyContent)).toBe("\n:::\n:::\n");
});
      
test("parseLectic-validInput", () => {
    const validInput = `---
interlocutor:
    prompt: value
    name: sam
---
::: assistant
Content A
:::
User text
::: assistant
Content B
:::`;

    const result = parseLectic(validInput);

    expect(result).not.toBeInstanceOf(Error);
    expect(result).toBeTruthy();
    expect((result as Lectic).header).toEqual({interlocutor: { prompt: "value", name: "sam" }});
    expect((result as Lectic).body.messages).toEqual([
        new Message({ role: "assistant", content: "Content A" }),
        new Message({ role: "user", content: "User text" }),
        new Message({ role: "assistant", content: "Content B" })
    ]);
});

test("parseLectic-invalidYaml", () => {
    const invalidYaml = `---
interlocutor:
    prompt: value
---
Body content`;

    const result = parseLectic(invalidYaml);

    expect(result).toBeInstanceOf(Error);
    expect((result as Error).message).toBe('YAML Header contains either unrecognized fields or is missing a field');
});

test("parseLectic-invalidYaml", () => {
    const invalidYaml = `---
interlocutor:
    prompt: value
    namme: value
---
Body content`;

    const result = parseLectic(invalidYaml);

    expect(result).toBeInstanceOf(Error);
    expect((result as Error).message).toBe('YAML Header contains either unrecognized fields or is missing a field');
});

test("parseLectic-noBody", () => {
    const noBody = `---
interlocutor:
    prompt: value
    name: sam
---
`;

    const result = parseLectic(noBody);

    expect((result as Lectic).body.messages).toEqual([]);
});

test("parseLectic-noHeaderNoBody", () => {
    const invalidInput = ``;
    const result = parseLectic(invalidInput);
    expect(result).toBeInstanceOf(Error);
    expect((result as Error).message).toBe('could not parse YAML header');
});

test("parseLectic-invalidDivider", () => {
    const invalidDivider = `-BAD-
interlocutor:
  prompt: value
  name: sam
-BAD-
Text without proper body markers`;
    const result = parseLectic(invalidDivider);
    expect(result).toBeInstanceOf(Error);
    expect((result as Error).message).toBe('could not parse YAML header');
});

test("parseLectic-nestedYAMLDelimiters", () => {
    const nestedDelimiters = `---
Header
--- Content does not start
--- More content
--- End`;
    const result = parseLectic(nestedDelimiters);
    expect(result).toBeInstanceOf(Error);
    expect((result as Error).message).toBe('YAML Header contains either unrecognized fields or is missing a field');
});

test("parseLectic-emptyContent", () => {
    const emptyContent = `---
interlocutor:
  prompt: value
  name: sam
---
::: :::
`;
    const result = parseLectic(emptyContent);
    expect(result).not.toBeInstanceOf(Error);
    expect((result as Lectic).body.messages).toEqual(
        [new Message({ role: "user", content: "::: :::" })]);
});

test("parseLectic-nonStringContent", () => {
    const nonStringContent = `---
interlocutor:
  prompt: value
  name: sam
---
["array", "of", "strings"]`;
    const result = parseLectic(nonStringContent);
    expect(result).not.toBeInstanceOf(Error);
    expect((result as Lectic).body.messages).toEqual(
        [new Message({ role: "user", content: '["array", "of", "strings"]' })]);
});
