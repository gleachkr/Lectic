import { describe, it, expect } from "bun:test"
import { UserMessage } from "./message"
import { emitCmdAttachments } from "./backend"

describe("emitCmdAttachments", () => {
  it("returns empty list when there are no :cmd directives", async () => {
    const msg = new UserMessage({ content: "hello" })
    const out = await emitCmdAttachments(msg)
    expect(out).toEqual([])
  })

  it("executes each :cmd directive and returns inline attachments", async () => {
    const msg = new UserMessage({
      content: "A :cmd[echo one] and then :cmd[echo two]",
    })

    const out = await emitCmdAttachments(msg)

    expect(out).toHaveLength(2)
    expect(out[0].kind).toBe("cmd")
    expect(out[0].command.trim()).toBe("echo one")
    expect(out[0].content).toContain("<stdout")
    expect(out[0].content).toContain("one")

    expect(out[1].kind).toBe("cmd")
    expect(out[1].command.trim()).toBe("echo two")
    expect(out[1].content).toContain("two")
  })

  it("ignores other directives", async () => {
    const msg = new UserMessage({
      content: ":ask[Nope] :cmd[echo ok] :reset[]",
    })

    const out = await emitCmdAttachments(msg)

    expect(out).toHaveLength(1)
    expect(out[0].command.trim()).toBe("echo ok")
  })
})
