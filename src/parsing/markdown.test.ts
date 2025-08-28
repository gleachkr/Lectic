import { describe, it, expect } from "bun:test";
import {
  replaceDirectives,
  parseDirectives,
  parseReferences,
  nodeContentRaw,
} from "./markdown";
import type { TextDirective } from "mdast-util-directive";

describe("replaceDirectives", () => {
  it("replaces a known directive and leaves unknown intact", () => {
    const input = "Hello :macro[world] and :unknown[keep me] end.";
    const out = replaceDirectives(input, (name, content) => {
      if (name === "macro") return content.toUpperCase();
      return null; // leave others as-is
    });

    expect(out).toContain("Hello WORLD and ");
    // unknown directive should still be serialized as a directive
    expect(out).toContain(":unknown[keep me]");
    // original macro directive should be gone
    expect(out).not.toContain(":macro[");
  });

  it("passes exact bracket content (including whitespace) to replacer", () => {
    const input = "Do :cmd[  ls -la  ] now";
    let seen: { name: string; content: string } | null = null;
    const out = replaceDirectives(input, (name, content) => {
      seen = { name, content };
      return "done";
    });

    expect(seen).not.toBeNull();
    expect(seen!.name).toBe("cmd");
    expect(seen!.content).toBe("  ls -la  ");
    expect(out).toContain("Do done now");
  });

  it("handles multiple directives and multiline replacements", () => {
    const input = "A :cmd[echo 1] and :macro[say hi]";
    const out = replaceDirectives(input, (name, _content) => {
      if (name === "cmd") return "1";
      if (name === "macro") return "line1\nline2";
      return null;
    });

    // First replaced inline
    expect(out).toContain("A 1 and ");
    // Second replaced with a newline preserved in output
    expect(out).toContain("line1\nline2");
    // Directives should be removed
    expect(out).not.toContain(":cmd[");
    expect(out).not.toContain(":macro[");
  });

  it("works when directive is at document boundaries", () => {
    const input = ":macro[start]\n\nMiddle\n\n:macro[end]";
    const out = replaceDirectives(input, (_name, content) => {
      return `[${content}]`;
    });

    const norm = out.replace(/\r?\n/g, "\n");
    // contains start and end markers
    expect(norm.includes("[start]")).toBe(true);
    expect(norm.includes("[end]")).toBe(true);
    // order is preserved
    expect(norm.indexOf("[start]")).toBeLessThan(norm.indexOf("Middle"));
    expect(norm.indexOf("Middle")).toBeLessThan(norm.indexOf("[end]"));
  });
  it("mdast roundtrip preserves internal newlines and no extra final NL", () => {
    const input = [
      "Line1",
      "",
      "Line2",
      "- item1",
      "- item2",
      "",
      "Paragraph with",
      "multiple\n\nlines",
    ].join("\n");

    const out = replaceDirectives(input, () => null);
    // internal paragraph newline preserved
    expect(out.includes("Paragraph with\nmultiple\n\nlines")).toBe(true);
    // input has no final newline; output should not either
    expect(/\r?\n$/.test(input)).toBe(false);
    expect(/\r?\n$/.test(out)).toBe(false);
  });

  it("trims a trailing newline only when input lacks one", () => {
    const inputNoNL = "Before :macro[x]"; // no final NL

    // Replace with text without newline -> result should have no final NL
    const out1 = replaceDirectives(inputNoNL, (name, _content) => {
      return name === "macro" ? "X" : null;
    });
    expect(/\r?\n$/.test(out1)).toBe(false);

    // Replace with text WITH newline at end -> we still trim one final NL
    const out2 = replaceDirectives(inputNoNL, (name, _content) => {
      return name === "macro" ? "X\n" : null;
    });
    expect(/\r?\n$/.test(out2)).toBe(false);

    // If input already has a final NL, we preserve one in the output
    const inputWithNL = "Before :macro[x]\n"; // with final NL
    const out3 = replaceDirectives(inputWithNL, (name, _content) => {
      return name === "macro" ? "Y" : null;
    });
    expect(/\r?\n$/.test(out3)).toBe(true);
  });
});

describe("parseDirectives and helpers", () => {
  it("finds inline directives and exposes their names and content", () => {
    const input = "Alpha :one[first] Beta :two[second item]";
    const nodes: TextDirective[] = parseDirectives(input);
    const names = nodes.map((n) => n.name);
    expect(names).toEqual(["one", "two"]);
    const contents = nodes.map((n) => nodeContentRaw(n as any, input));
    expect(contents).toEqual(["first", "second item"]);
  });
});

describe("parseReferences", () => {
  it("finds links and images", () => {
    const input =
      "Here is a [link](https://example.com) and an image ![alt](/img.png)";
    const refs = parseReferences(input);
    // one link + one image
    expect(refs.length).toBe(2);
    const urls = refs.map((r: any) => r.url);
    expect(urls).toContain("https://example.com");
    expect(urls).toContain("/img.png");
  });
});
