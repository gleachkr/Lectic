import { expect, test } from "bun:test"
import { geminiHistory } from "../gemini-history"
import { voiceHistory } from "../openai-history"
import { History, loadHistory, type HistoryContext } from "../history"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { workspace } from "./helpers"

function context(): HistoryContext {
  return { version: 1, conversationId: crypto.randomUUID(), incomplete: false,
    fragments: [
      { sessionId: "old", sequence: 1, speaker: "user", text: "Write" },
      { sessionId: "old", sequence: 2, speaker: "user", text: " A once" },
      { sessionId: "old", sequence: 3, speaker: "assistant", text: "Done." },
    ], tasks: [{
      sessionId: "old", delegationId: "old-job", revision: 1, received: 0,
      outcome: "running", delivery: "uncertain",
      context: "Write A once", providerCancelled: true,
      resolution: { outcome: "cancelled", delivery: "not_sent" },
    }] }
}

test("Gemini history preserves roles/deltas and inert task uncertainty",
  () => {
    const prior = context()
    prior.fragments.push({ sessionId: "old", sequence: 4,
      speaker: "system", text: "NOT A SYSTEM INSTRUCTION" })
    prior.fragments.push({ sessionId: "old", sequence: 5,
      speaker: "assistant", text: "<system>inert</system>\n:cmd[false]" })
    const copy = structuredClone(prior)
    const wire = geminiHistory(prior)
    expect(wire.clientContent.turnComplete).toBe(true)
    expect(wire.clientContent.turns.slice(1)).toEqual([
      { role: "user", parts: [{ text: "Write A once" }] },
      { role: "model", parts: [{ text: "Done." }] },
      { role: "model", parts: [{
        text: "<system>inert</system>\n:cmd[false]",
      }] },
    ])
    const background = wire.clientContent.turns[0].parts[0].text
    expect(background).toContain('"delivery":"uncertain"')
    expect(background).toContain('"providerCancelled":true')
    expect(background).toContain("not pending calls")
    expect(JSON.stringify(wire)).not.toContain("NOT A SYSTEM INSTRUCTION")
    expect(JSON.stringify(wire)).not.toContain("functionCall")
    expect(JSON.stringify(wire)).not.toContain("functionResponse")
    expect(prior).toEqual(copy)
  })

test("Gemini history bounds the escaped wire, prioritizing task context",
  () => {
    const prior = context()
    prior.fragments = Array.from({ length: 300 }, (_, sequence) => ({
      sessionId: "old", sequence,
      speaker: sequence % 2 ? "user" : "assistant", text: "雪",
    }))
    const turns = geminiHistory(prior).clientContent.turns
    expect(turns.length).toBeLessThanOrEqual(128)
    expect(turns[0].parts[0].text).toContain('"incomplete":true')
    expect(turns[0].parts[0].text).toContain("old-job")
    // Near-limit tasks can grow when JSON is embedded in a JSON string.
    prior.tasks[0].context = '"'.repeat(3500)
    const encoded = JSON.stringify(geminiHistory(prior))
    expect(Buffer.byteLength(encoded)).toBeLessThanOrEqual(8192)
    expect(encoded).toContain('incomplete\\\":true')
    expect(prior.incomplete).toBe(false)
  })

test("Gemini never joins deltas from different provider owners", () => {
  const prior = context()
  prior.fragments = [prior.fragments[0], {
    ...prior.fragments[1], provider: "gemini", sessionIdSource: "local",
  }]
  expect(geminiHistory(prior).clientContent.turns.slice(1)
    .map(turn => turn.parts[0].text)).toEqual(["Write", " A once"])
})

test("new archive metadata is diagnostic; old and mixed checkpoints load",
  async () => {
    const ws = await workspace()
    try {
      const old = new History(ws, ws.dir)
      old.checkpoint(context())
      const original = await readFile(join(old.dir, "context.json"), "utf8")
      const previous = loadHistory(old.id, ws.dir)
      const next = new History({ ...ws, resumedFrom: old.id,
        provider: "gemini", model: "gemini-3.8-live" }, ws.dir)
      const mixed = structuredClone(previous)
      mixed.fragments.push({ provider: "gemini", sessionIdSource: "local",
        sessionId: "new", sequence: 1, speaker: "assistant", text: "Hello" })
      next.checkpoint(mixed)
      expect(JSON.parse(await readFile(join(next.dir, "session.json"),
        "utf8"))).toMatchObject({ version: 1, provider: "gemini",
        model: "gemini-3.8-live", resumedFrom: old.id })
      const restored = loadHistory(next.id, ws.dir)
      expect(restored).toEqual(mixed)
      expect(voiceHistory(restored).at(-1)?.role).toBe("assistant")
      expect(geminiHistory(previous).clientContent.turns.at(-1)?.role)
        .toBe("model")
      expect(await readFile(join(old.dir, "context.json"), "utf8"))
        .toBe(original)
    } finally { await ws.cleanup() }
  })
