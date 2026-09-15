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

test("idle timeout CLI defaults and bounds", () => {
  expect(parseArgs(["-f", "seed"]).idleTimeout).toBe(30)
  expect(parseArgs(["-f", "seed", "--idle-timeout", "60"]).idleTimeout)
    .toBe(60)
  for (const value of ["0", "-1", "3601", "NaN", "1.5", "Infinity"]) {
    expect(() => parseArgs(["-f", "seed", "--idle-timeout", value]))
      .toThrow("Invalid value")
  }
  expect(() => parseArgs(["-f", "seed", "--idle-timeout"]))
    .toThrow("Missing value")
})

test("usage accumulates with a minimum charge per wake", () => {
  const usage = new Usage()
  usage.update(30, true)
  usage.nextSession()
  expect(usage.snapshot(true)).toMatchObject({
    seconds: 30, final: false, estimatedBillableSeconds: 45,
  })
  usage.update(2, true)
  expect(usage.seconds).toBe(32)
  usage.nextSession()
  usage.update(20)
  usage.update(19)
  expect(usage.snapshot(true).estimatedBillableSeconds).toBe(65)
  usage.update(18, true)
  expect(usage.snapshot(true)).toMatchObject({
    seconds: 50, final: true, finalSeconds: 50,
    estimatedBillableSeconds: 63,
  })
})

test("rejected creation removes only the new speculative minimum", () => {
  const usage = new Usage()
  usage.update(2, true)
  usage.nextSession()
  usage.update(91.122, true)
  usage.nextSession()
  usage.rejectCreation()
  usage.update(999)
  expect(usage.snapshot(true)).toMatchObject({
    seconds: 93.122, final: true, finalSeconds: 93.122,
    estimatedBillableSeconds: 106.122,
  })
})
