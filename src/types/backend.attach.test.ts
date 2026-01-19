import { describe, it, expect } from "bun:test"
import { UserMessage } from "./message"

describe("UserMessage inlineAttachments", () => {
  it("collects :attach content as an inline attachment", async () => {
    const msg = new UserMessage({ content: ":attach[derp]" })

    // Simulate this being the last message.
    await msg.expandMacros([], { MESSAGE_INDEX: 1, MESSAGES_LENGTH: 1 })

    expect(msg.inlineAttachments).toHaveLength(1)
    expect(msg.inlineAttachments[0].kind).toBe("attach")
    expect(msg.inlineAttachments[0].mimetype).toBe("text/plain")
    expect(msg.inlineAttachments[0].content).toBe("derp")

    // :attach expands to nothing in the final user message.
    expect(msg.content).not.toContain(":attach[")
  })
})

describe("emitInlineAttachments", () => {
  it("preserves document order among :attach directives", async () => {
    const msg = new UserMessage({
      content: ":attach[a] :attach[:cmd[echo one]] :attach[b]",
    })

    // Simulate this being the last message, so :cmd is expanded within :attach.
    await msg.expandMacros([], { MESSAGE_INDEX: 1, MESSAGES_LENGTH: 1 })

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
