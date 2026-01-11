import { describe, it, expect } from "bun:test"
import { UserMessage } from "./message"
import { emitAttachAttachments, emitDirectiveAttachments } from "./backend"

describe("emitAttachAttachments", () => {
  it("creates an inline attachment with verbatim content", () => {
    const msg = new UserMessage({ content: ":attach[derp]" })
    const out = emitAttachAttachments(msg)

    expect(out).toHaveLength(1)
    expect(out[0].kind).toBe("attach")
    expect(out[0].mimetype).toBe("text/plain")
    expect(out[0].content).toBe("derp")
  })
})

describe("emitDirectiveAttachments", () => {
  it("preserves document order among :attach directives", async () => {
    const msg = new UserMessage({
      content: ":attach[a] :attach[:cmd[echo one]] :attach[b]",
    })

    // Simulate this being the last message, so :cmd is expanded within :attach.
    await msg.expandMacros([], { MESSAGE_INDEX: 1, MESSAGES_LENGTH: 1 })

    const out = await emitDirectiveAttachments(msg)

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
