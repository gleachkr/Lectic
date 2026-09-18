import { expect, test } from "bun:test"
import { extractResult, MAX_RESULT_BYTES } from "../result"

const terminal = {
  type: "code", lang: "lectic-live-result",
  value: '{"status":"completed","summary":"Public finding."}',
}
const parsed = (content: unknown[]) => ({
  messages: [{ role: "assistant", content }],
})

test("only terminal envelope is returned, not thoughts/tools/hooks/prose",
  () => {
    expect(extractResult(parsed([
      { type: "paragraph", children: [
        { type: "text", value: "intermediate" },
      ] },
      { type: "tool-call", value: "SECRET TOOL DUMP" },
      { type: "thought-block", value: "PRIVATE REASONING" },
      { ...terminal, value: '{"status":"completed","summary":"EARLY"}' },
      { type: "inline-attachment", value: "HOOK ASKS FOR ANOTHER PASS" },
      terminal,
    ]))).toEqual({ status: "completed", summary: "Public finding." })
  })

test("incomplete, error-bearing, and malformed output fails closed", () => {
  for (const value of [
    {}, parsed([]), parsed([{ type: "paragraph", value: "raw stdout" }]),
    parsed([terminal, { type: "inline-attachment", value: "More work" }]),
    parsed([{ type: "html", value: "<error>Runaway</error>" }, terminal]),
    parsed([{ type: "html", value: "<hook-error>Oops</hook-error>" }]),
    parsed([{ ...terminal, value: "malformed JSON" }]),
    parsed([{ ...terminal, value: '{"status":"completed","summary":42}' }]),
    parsed([{ ...terminal, value: JSON.stringify({
      status: "completed", summary: "x", private: "secret",
    }) }]),
    parsed([{ ...terminal, value: JSON.stringify({
      status: "completed",
      summary: "雪".repeat(Math.ceil(MAX_RESULT_BYTES / 3)),
    }) }]),
    { messages: [{ role: "user", content: [terminal] }] },
  ]) expect(() => extractResult(value)).toThrow()
})

test("clarification and explicit failure remain distinct outcomes", () => {
  for (const status of ["clarification", "failed"] as const) {
    expect(extractResult(parsed([{ ...terminal, value: JSON.stringify({
      status, summary: "Need more information.",
    }) }])).status).toBe(status)
  }
})

for (const summary of ["a".repeat(MAX_RESULT_BYTES), "雪🙂".repeat(2000)]) {
  test(`public results accept ${Buffer.byteLength(summary)} UTF-8 bytes`,
    () => {
      expect(extractResult(parsed([{ ...terminal, value: JSON.stringify({
        status: "completed", summary,
      }) }]))).toEqual({ status: "completed", summary })
    })
}
