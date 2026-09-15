import { expect, test } from "bun:test"
import { createIdleState } from "../idle"

function active(timeout = 30_000) {
  const state = createIdleState(timeout, 0)
  state.mode("active", 0)
  state.sample(0, 0, 0, false)
  return state
}

test("idle fades from half-time to the configured deadline", () => {
  for (const timeout of [1000, 30_000, 60_000]) {
    const state = active(timeout)
    expect(state.sample(timeout / 2, 0, 0, false))
      .toEqual({ dim: 0, idle: false, wake: false })
    expect(state.sample(timeout * .75, 0, 0, false).dim).toBe(.5)
    expect(state.sample(timeout, 0, 0, false))
      .toEqual({ dim: 1, idle: true, wake: false })
  }
})

test("agent audio, transcript activity and backend work delay idle", () => {
  const state = active()
  expect(state.sample(29_000, 0, .02, false).dim).toBe(0)
  expect(state.sample(58_000, 0, 0, true).idle).toBe(false)
  state.activity(87_000)
  expect(state.sample(116_999, 0, 0, false).idle).toBe(false)
  expect(state.sample(117_000, 0, 0, false).idle).toBe(true)
})

test("steady noise sleeps; sudden rises and falls wake", () => {
  const state = createIdleState(30_000, 0)
  state.mode("active", 0)
  for (let at = 0; at < 30_000; at += 50) {
    expect(state.sample(at, .05, 0, false).idle).toBe(false)
  }
  expect(state.sample(30_000, .05, 0, false).idle).toBe(true)
  state.mode("sleeping", 30_000)
  expect(state.sample(40_000, .052, .1, true).wake).toBe(false)
  // Transcripts and remote/backend activity cannot wake a sleeping session.
  state.activity(40_010)
  expect(state.sample(40_050, .052, 0, false).wake).toBe(false)
  expect(state.sample(40_100, .2, 0, false).wake).toBe(true)
  state.recalibrate(50_000)
  state.sample(50_000, .05, 0, false)
  expect(state.sample(50_050, 0, 0, false).wake).toBe(true)
})

test("startup and suspended audio cannot cause idle or wake", () => {
  const state = createIdleState(1000, 0)
  expect(state.sample(10_000, .5, 0, false).idle).toBe(false)
  state.mode("sleeping", 10_000)
  state.recalibrate(20_000)
  expect(state.sample(20_050, 0, 0, false).wake).toBe(false)
  expect(state.sample(20_100, .005, 0, false).wake).toBe(false)
})
