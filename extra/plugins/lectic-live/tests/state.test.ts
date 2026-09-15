import { expect, test } from "bun:test"
import { Journal, Usage } from "../state"
import { parseArgs } from "../lectic-live"

test("cumulative usage is monotonic until final accounting", () => {
  const usage = new Usage()
  expect(usage.snapshot(false).estimatedVoiceCost).toBe(0)
  expect(usage.snapshot(true).estimatedBillableSeconds).toBe(15)
  for (const seconds of [10, 10, 12, 8]) usage.update(seconds)
  expect(usage.seconds).toBe(12)
  usage.update(20)
  expect(usage.snapshot(true).estimatedBillableSeconds).toBe(20)
  usage.update(18, true)
  usage.update(21)
  usage.update(14, true)
  expect(usage.snapshot(true)).toEqual({
    seconds: 18, final: true, finalSeconds: 18,
    estimatedBillableSeconds: 18, estimatedVoiceCost: 18 / 60 * .05,
    backendCost: null,
  })
})

test("diagnostic retention is bounded and snapshots cannot mutate it", () => {
  const journal = new Journal()
  for (let n = 0; n < 300; n++) journal.add("backend_started", n)
  const events = journal.snapshot()
  expect(events).toHaveLength(256)
  expect(events[0].sequence).toBe(45)
  events[0].code = "cancelled"
  expect(journal.snapshot()[0].code).toBe("backend_started")
})

test("context retention CLI defaults and bounds", () => {
  expect(parseArgs(["-f", "seed"]).contextSeconds).toBe(300)
  expect(parseArgs(["-f", "seed", "--context-seconds", "30"])
    .contextSeconds).toBe(30)
  for (const value of ["0", "-1", "3601", "NaN", "1.5"]) {
    expect(() => parseArgs(["-f", "seed", "--context-seconds", value]))
      .toThrow("Invalid value")
  }
})
