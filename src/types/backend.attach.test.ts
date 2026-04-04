import { describe, it, expect } from "bun:test"
import { UserMessage } from "./message"

describe("UserMessage inlineAttachments", () => {
  it("collects :attach content as an inline attachment", async () => {
    const msg = new UserMessage({ content: ":attach[derp]" })

    // Simulate this being the last message.
    await msg.expandMacros([], {
      MESSAGE_TEXT: msg.content,
      MESSAGE_INDEX: 1,
      MESSAGES_LENGTH: 1,
    })

    expect(msg.inlineAttachments).toHaveLength(1)
    expect(msg.inlineAttachments[0].kind).toBe("attach")
    expect(msg.inlineAttachments[0].mimetype).toBe("text/plain")
    expect(msg.inlineAttachments[0].content).toBe("derp")

    // :attach expands to nothing in the final user message.
    expect(msg.content).not.toContain(":attach[")
  })

  it("supports :attach metadata attributes", async () => {
    const msg = new UserMessage({
      content: ":attach[payload]{icon=\"🧪\" name=\"snapshot\" id=\"x1\"}",
    })

    await msg.expandMacros([], {
      MESSAGE_TEXT: msg.content,
      MESSAGE_INDEX: 1,
      MESSAGES_LENGTH: 1,
    })

    expect(msg.inlineAttachments).toHaveLength(1)
    const att = msg.inlineAttachments[0]

    expect(att.icon).toBe("🧪")
    expect(att.mimetype).toBe("text/plain")
    expect(att.attributes).toEqual({
      name: "snapshot",
      id: "x1",
      icon: "🧪",
    })
  })

  it("auto-detects JSON mimetype from content", async () => {
    const msg = new UserMessage({
      content: ':attach[{"key": "value"}]',
    })

    await msg.expandMacros([], {
      MESSAGE_TEXT: msg.content,
      MESSAGE_INDEX: 1,
      MESSAGES_LENGTH: 1,
    })

    expect(msg.inlineAttachments).toHaveLength(1)
    expect(msg.inlineAttachments[0].mimetype).toBe("application/json")
  })

  it("auto-detects HTML mimetype from content", async () => {
    const msg = new UserMessage({
      content: ":attach[<!DOCTYPE html><html></html>]",
    })

    await msg.expandMacros([], {
      MESSAGE_TEXT: msg.content,
      MESSAGE_INDEX: 1,
      MESSAGES_LENGTH: 1,
    })

    expect(msg.inlineAttachments).toHaveLength(1)
    expect(msg.inlineAttachments[0].mimetype).toBe("text/html")
  })

  it("allows manual mimetype override via attribute", async () => {
    const msg = new UserMessage({
      content: ':attach[some content]{mimetype="application/xml"}',
    })

    await msg.expandMacros([], {
      MESSAGE_TEXT: msg.content,
      MESSAGE_INDEX: 1,
      MESSAGES_LENGTH: 1,
    })

    expect(msg.inlineAttachments).toHaveLength(1)
    expect(msg.inlineAttachments[0].mimetype).toBe("application/xml")
  })

  it("manual mimetype override takes precedence over detection", async () => {
    const msg = new UserMessage({
      content: ':attach[{"key": "value"}]{mimetype="text/plain"}',
    })

    await msg.expandMacros([], {
      MESSAGE_TEXT: msg.content,
      MESSAGE_INDEX: 1,
      MESSAGES_LENGTH: 1,
    })

    expect(msg.inlineAttachments).toHaveLength(1)
    expect(msg.inlineAttachments[0].mimetype).toBe("text/plain")
  })

  it("auto-detects base64-encoded PNG as image/png", async () => {
    const pngBytes = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ])
    const b64 = Buffer.from(pngBytes).toString("base64")
    const msg = new UserMessage({ content: `:attach[${b64}]` })

    await msg.expandMacros([], {
      MESSAGE_TEXT: msg.content,
      MESSAGE_INDEX: 1,
      MESSAGES_LENGTH: 1,
    })

    expect(msg.inlineAttachments).toHaveLength(1)
    expect(msg.inlineAttachments[0].mimetype).toBe("image/png")
  })
})

describe("emitInlineAttachments", () => {
  it("preserves document order among :attach directives", async () => {
    const msg = new UserMessage({
      content: ":attach[a] :attach[:cmd[echo one]] :attach[b]",
    })

    // Simulate this being the last message, so :cmd is expanded within :attach.
    await msg.expandMacros([], { MESSAGE_TEXT: msg.content,  MESSAGE_INDEX: 1, MESSAGES_LENGTH: 1 })

    const out = msg.inlineAttachments

    expect(out).toHaveLength(3)
    expect(out[0].kind).toBe("attach")
    expect(out[0].content).toBe("a")

    expect(out[1].kind).toBe("attach")
    expect(out[1].content).toContain("<stdout")
    expect(out[1].content).toContain("echo one")
    expect(out[1].content).toContain("one")

    expect(out[2].kind).toBe("attach")
    expect(out[2].content).toBe("b")
  })
})
