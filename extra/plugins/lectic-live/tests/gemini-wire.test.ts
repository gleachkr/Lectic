import { expect, test } from "bun:test"
import { decode, historySeed, setup, toolResult } from "../gemini-spike/wire"
import corpus from "./fixtures/gemini/contract.json"

for (const fixture of corpus.server) {
  test(`Gemini decoder accepts synthetic ${fixture.id}`, () => {
    expect(() => decode(JSON.stringify(fixture.wire))).not.toThrow()
  })
}
const malformed = corpus.malformed.filter(f => f.direction === "server")
for (const fixture of malformed) {
  test(`Gemini decoder rejects synthetic ${fixture.id}`, () => {
    expect(() => decode(JSON.stringify(fixture.wire))).toThrow()
  })
}

test("Gemini setup and response match checked wire field placement", () => {
  const config = setup(false, true).setup
  expect(config.historyConfig)
    .toEqual({ initialHistoryInClientContent: true })
  expect(config.tools[0].functionDeclarations[0].behavior)
    .toBe("NON_BLOCKING")
  expect(config.model).toBe("models/gemini-3.8-live")
  expect(config.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig)
    .toEqual({ voiceName: "Kore" })
  expect(setup(false, false).setup).not.toHaveProperty("historyConfig")
  expect(historySeed.clientContent.turnComplete).toBe(true)
  expect<unknown>(toolResult("call-1", "A bounded public summary."))
    .toEqual(corpus.client.find(f => f.id === "result-when-idle")!.wire)
})

test("transcript strings are exact; usage coexists; interruption wins audio",
  () => {
    const content = {
      inputTranscription: { text: " no no", finished: true },
      outputTranscription: { text: " now." },
      interimInputTranscription: { text: 42 },
      modelTurn: { parts: [{ inlineData: {
        mimeType: "audio/pcm;rate=24000", data: "AACA/w==",
      } }] },
      interrupted: true,
    }
    const events = decode(JSON.stringify({ serverContent: content,
      usageMetadata: { totalTokenCount: 10 } }))
    expect(events).toEqual([
      { type: "interrupted" },
      { type: "input", text: " no no" },
      { type: "output", text: " now." },
      { type: "usage", counters: { totalTokenCount: 10 } },
    ])
    expect(decode(JSON.stringify({ serverContent: {
      inputTranscription: { text: " no no" },
    } }))).toEqual([{ type: "input", text: " no no" }])
  })

test("wire parsing enforces size, task, array, and canonical base64 bounds",
  () => {
    expect(() => decode(" ".repeat(512 * 1024 + 1))).toThrow()
    for (const task of ["", " ", "a".repeat(4097)]) {
      expect(() => decode(JSON.stringify({ toolCall: { functionCalls: [{
        name: "delegate", id: "id", args: { task },
      }] } }))).toThrow()
    }
    expect(() => decode(JSON.stringify({ toolCallCancellation: {
      ids: Array(33).fill("id"),
    } }))).toThrow()
    expect(() => decode(JSON.stringify({ serverContent: { modelTurn: {
      parts: [{ inlineData: { mimeType: "audio/pcm;rate=24000",
        data: "AAB=", // Noncanonical padding bits, otherwise two bytes.
      } }],
    } } }))).toThrow()
    expect(() => decode('{"error":{"message":"secret"}}')).toThrow()
  })
