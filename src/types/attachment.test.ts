import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { MessageAttachment } from "./attachment";
import type { MessageLink } from "./link";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { pathToFileURL } from "url";

function makeLink(text: string, URI: string): MessageLink {
  return { text, URI } as MessageLink;
}

describe("MessageAttachment: globbing and env expansion", () => {
  const tmpRoot = mkdtempSync(join(tmpdir(), "lectic-attach-test-"));
  const absRoot = resolve(tmpRoot);
  const files = [
    join(absRoot, "test1.txt"),
    join(absRoot, "test2.txt"),
    // include a literal "$" in the filename to ensure we don't
    // accidentally expand again on concrete paths
    join(absRoot, "a$b.txt"),
  ];

  beforeAll(() => {
    // create files
    for (const f of files) writeFileSync(f, `contents of ${f}`);
    // expose absolute dir via env var
    process.env["ATTACH_TEST_DIR"] = absRoot;
  });

  afterAll(() => {
    try {
      rmSync(absRoot, { recursive: true, force: true });
    } catch (_) {
      // ignore
    }
    delete process.env["ATTACH_TEST_DIR"];
  });

  it("fromGlob expands env vars for plain path patterns", async () => {
    const pattern = "$ATTACH_TEST_DIR/*.txt";
    const link = makeLink("glob", pattern);
    const attachments = MessageAttachment.fromGlob(link);
    // Should match test1.txt, test2.txt, and a$b.txt
    expect(attachments.length).toBe(3);
    // All returned attachments should point to concrete files that exist
    for (const att of attachments) {
      expect(await att.exists()).toBe(true);
    }
  });

  it("fromGlob supports file:// patterns with env vars", async () => {
    const dirURL = pathToFileURL(process.env["ATTACH_TEST_DIR"] as string).href;
    const link = makeLink("glob", `${dirURL}/*.txt`);
    const attachments = MessageAttachment.fromGlob(link);
    expect(attachments.length).toBe(3);
    for (const att of attachments) {
      expect(await att.exists()).toBe(true);
    }
  });

  it("fromGlob falls back to a single attachment when no files match", () => {
    const pattern = "$ATTACH_TEST_DIR/*.md";
    const link = makeLink("no-match", pattern);
    const attachments = MessageAttachment.fromGlob(link);
    expect(attachments.length).toBe(1);
    // Don't dereference the attachment further; constructor will handle
    // any expansion or parsing as usual.
  });

  it("constructor expands env vars in file:// URIs and parses fragments", async () => {
    const dirURL = pathToFileURL(process.env["ATTACH_TEST_DIR"] as string).href;
    const link = makeLink(
      "file with fragment",
      `${dirURL}/test1.txt#pages=2-4`
    );
    const att = new MessageAttachment(link);
    const parts = await att.getParts();
    expect(parts.length).toBe(1);
    expect(parts[0].fragmentParams?.get("pages")).toBe("2-4");
  });

  it("no double expansion on concrete file paths containing $", async () => {
    // Use fromGlob to get concrete paths (which may include ') and ensure
    // constructor does not try to expand again on plain paths.
    const pattern = "$ATTACH_TEST_DIR/a*.txt";
    const link = makeLink("glob", pattern);
    const attachments = MessageAttachment.fromGlob(link);
    // Should include a$b.txt specifically
    const hasDollar = attachments.some((att) => att.URI.endsWith("a$b.txt"));
    expect(hasDollar).toBe(true);
    for (const att of attachments) {
      expect(await att.exists()).toBe(true);
    }
  });
});

describe("MessageAttachment: data URLs", () => {
  it("parses base64 image data URLs", async () => {
    // minimal 1x1 transparent PNG
    const pngBase64 =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGMAAQAABQAB" +
      "J4nW3QAAAABJRU5ErkJggg==";
    const uri = `data:image/png;base64,${pngBase64}`;
    const att = new MessageAttachment({ text: "img", URI: uri });
    expect(await att.exists()).toBe(true);
    const parts = await att.getParts();
    expect(parts.length).toBe(1);
    expect(parts[0].mimetype).toBe("image/png");
    expect(parts[0].bytes.length).toBeGreaterThan(0);
  });

  it("parses non-base64 text data URLs", async () => {
    const uri = "data:text/plain,hello%20world";
    const att = new MessageAttachment({ text: "txt", URI: uri });
    expect(await att.exists()).toBe(true);
    const parts = await att.getParts();
    expect(parts.length).toBe(1);
    expect(parts[0].mimetype).toBe("text/plain");
    const decoded = new TextDecoder().decode(parts[0].bytes);
    expect(decoded).toBe("hello world");
  });
});
