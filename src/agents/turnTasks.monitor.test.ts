import { describe, expect, test } from "bun:test"

import { TurnTaskStore } from "./turnTasks"

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

describe("TurnTaskStore", () => {
  test("emits updates when onChunk is called mid-turn", async () => {
    const store = new TurnTaskStore({
      maxTasksPerContext: 50,
      runTurn: async ({ onChunk }) => {
        onChunk("first")
        await delay(10)
        onChunk("second")
      },
    })

    const events: Array<{ kind: string; len: number; state: string }> = []

    const unsub = store.onEvent((ev) => {
      events.push({
        kind: ev.kind,
        len: ev.snapshot.messageChunks.length,
        state: ev.snapshot.state,
      })
    })

    try {
      const h = store.enqueueTurn({ contextId: "c", userText: "hi" })
      const terminal = await h.waitForTerminal()

      expect(terminal.state).toBe("completed")
      expect(terminal.messageChunks).toEqual(["first", "second"])

      const sawLen1 = events.some((e) => e.kind === "updated" && e.len === 1)
      const sawLen2 = events.some((e) => e.kind === "updated" && e.len === 2)

      expect(sawLen1).toBe(true)
      expect(sawLen2).toBe(true)
    } finally {
      unsub()
    }
  })
})
