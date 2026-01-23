import { describe, expect, test } from "bun:test"

import { a2aTranscriptPath }
  from "./persistedRuntime"

describe("a2aTranscriptPath", () => {
  test("builds expected path", () => {
    const p = a2aTranscriptPath({
      stateDir: "/state",
      workspaceKey: "wk",
      agentId: "assistant",
      contextId: "ctx",
    })

    expect(p).toBe("/state/a2a/wk/assistant/ctx.lec")
  })
})
