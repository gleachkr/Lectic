import { expect, test } from "bun:test"
import { extractResult, MAX_RESULT_BYTES } from "../result"

const terminal = {
  type: "code", lang: "lectic-live-completed",
  value: "Public finding.",
}
const parsed = (content: unknown[]) => ({
  messages: [{ role: "assistant", content }],
})

test("only the final status fence is returned, not private context",
  () => {
    expect(extractResult(parsed([
      { type: "paragraph", children: [
        { type: "text", value: "intermediate" },
      ] },
      { type: "tool-call", value: "SECRET TOOL DUMP" },
      { type: "thought-block", value: "PRIVATE REASONING" },
      { ...terminal, value: "EARLY" },
      { type: "inline-attachment", value: "HOOK ASKS FOR ANOTHER PASS" },
      terminal,
    ]))).toEqual({ status: "completed", summary: "Public finding." })
  })

test("plain text preserves quotes, Unicode, and literal backslash-newline",
  () => {
    const summary = 'Listed "src": auth, backends, '
      + String.fromCharCode(92) + "\n" + "generateCmd.ts, 雪🙂."
    expect(extractResult(parsed([{ ...terminal, value: summary }]))).toEqual({
      status: "completed", summary,
    })
  })

test("incomplete, error-bearing, and malformed output fails closed", () => {
  for (const value of [
    {}, parsed([]), parsed([{ type: "paragraph", value: "raw stdout" }]),
    parsed([terminal, { type: "inline-attachment", value: "More work" }]),
    parsed([{ type: "html", value: "<error>Runaway</error>" }, terminal]),
    parsed([{ type: "html", value: "<hook-error>Oops</hook-error>" }]),
    parsed([{ ...terminal, value: " \n " }]),
    parsed([{ ...terminal, lang: "lectic-live-unknown" }]),
    parsed([{ ...terminal, lang: "lectic-live-completed-extra" }]),
    parsed([{ ...terminal, lang: "lectic-live-result",
      value: '{"status":"completed","summary":"old format"}' }]),
    parsed([{ ...terminal, value: "雪".repeat(
      Math.ceil((MAX_RESULT_BYTES + 1) / 3)) }]),
    { messages: [{ role: "user", content: [terminal] }] },
  ]) expect(() => extractResult(value)).toThrow()
})

test("clarification and explicit failure remain distinct outcomes", () => {
  for (const status of ["clarification", "failed"] as const) {
    expect(extractResult(parsed([{ ...terminal,
      lang: `lectic-live-${status}`, value: "Need more information.",
    }]))).toEqual({ status, summary: "Need more information." })
  }
})

for (const summary of ["a".repeat(MAX_RESULT_BYTES), "雪🙂".repeat(2000)]) {
  test(`public results accept ${Buffer.byteLength(summary)} UTF-8 bytes`,
    () => {
      expect(extractResult(parsed([{ ...terminal, value: summary }]))).toEqual({
        status: "completed", summary,
      })
    })
}
