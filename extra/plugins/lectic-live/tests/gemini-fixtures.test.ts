import { expect, test } from "bun:test"
import corpus from "./fixtures/gemini/contract.json"

// Corpus checks only. gemini-wire.test.ts exercises the production codec.
// Do not add a second parser here or treat fixtures as live evidence.
const messages = [...corpus.client, ...corpus.server]
const fixture = (id: string): any => {
  const entry = messages.find(message => message.id === id)
  if (!entry) throw new Error(`Missing synthetic fixture: ${id}`)
  return entry.wire
}

test("Gemini contract corpus is bounded and uniquely addressable", () => {
  expect(Buffer.byteLength(JSON.stringify(corpus))).toBeLessThan(64 * 1024)
  const entries = [...messages, ...corpus.malformed]
  expect(new Set(entries.map(entry => entry.id)).size).toBe(entries.length)
  for (const entry of entries) {
    expect(entry.id).toMatch(/^[a-zA-Z0-9-]+$/)
    expect(Buffer.byteLength(JSON.stringify(entry.wire)))
      .toBeLessThanOrEqual(4 * 1024)
  }
  for (const entry of corpus.malformed) {
    expect(["client", "server"]).toContain(entry.direction)
    expect(entry.path.length).toBeGreaterThan(0)
  }
  for (const sequence of corpus.sequences) {
    expect(sequence.expectation.length).toBeGreaterThan(0)
    for (const id of sequence.events) expect(fixture(id)).toBeDefined()
  }
})

test("Gemini corpus pins wire setup rather than SDK configuration", () => {
  const setup = fixture("setup-history").setup
  expect(setup.model).toBe("models/gemini-3.8-live")
  expect(setup.generationConfig).toEqual({
    responseModalities: ["AUDIO"],
    speechConfig: {
      voiceConfig: { prebuiltVoiceConfig: { voiceName: "Kore" } },
    },
  })
  expect(setup.inputAudioTranscription).toEqual({})
  expect(setup.outputAudioTranscription).toEqual({})
  expect(setup.historyConfig).toEqual({ initialHistoryInClientContent: true })
  expect(setup).not.toHaveProperty("sessionResumption")
  expect(setup).not.toHaveProperty("proactivity")
  const [declaration] = setup.tools[0].functionDeclarations
  expect(declaration.name).toBe("delegate")
  expect(declaration.behavior).toBe("NON_BLOCKING")
  expect(declaration.parameters.required).toEqual(["task"])
  expect(fixture("history-final").clientContent).toEqual({
    turns: [
      { role: "user", parts: [{ text: "An old question." }] },
      { role: "model", parts: [{ text: "An old answer." }] },
    ],
    turnComplete: true,
  })
})

test("Gemini corpus pins scheduling beside the result, not inside it", () => {
  const { functionResponses } = fixture("result-when-idle").toolResponse
  const [response] = functionResponses
  expect(response).toEqual({
    id: "call-1", name: "delegate",
    response: { result: "A bounded public summary." },
    scheduling: "WHEN_IDLE", willContinue: false,
  })
  expect(fixture("call").toolCall.functionCalls[0].id).toBe(response.id)
  expect(fixture("cancel")).toEqual({
    toolCallCancellation: { ids: [response.id] },
  })
})

test("Gemini corpus pins synthetic PCM and explicit native rates", () => {
  for (const rate of [44100, 48000]) {
    const audio = fixture(`input-${rate}`).realtimeInput.audio
    expect(audio.mimeType).toBe(`audio/pcm;rate=${rate}`)
    const bytes = Buffer.from(audio.data, "base64")
    expect(bytes.length).toBe(4)
    expect(bytes.readInt16LE(0)).toBe(0)
    expect(bytes.readInt16LE(2)).toBe(-128)
  }
  const audio = fixture("audio").serverContent.modelTurn.parts[0].inlineData
  expect(audio.mimeType).toBe("audio/pcm;rate=24000")
  expect(audio.data).toBe("AACA/w==")
})

test("Gemini corpus retains coexisting fields and transcript uncertainty",
  () => {
    const combined = fixture("combined-content").serverContent
    expect(combined.outputTranscription.text).toBe(" now.")
    expect(combined.modelTurn.parts).toHaveLength(1)
    expect(combined.generationComplete).toBe(true)
    const withUsage = fixture("usage-with-turn")
    expect(withUsage.serverContent.turnComplete).toBe(true)
    expect(withUsage.usageMetadata.totalTokenCount).toBe(140)
    expect(fixture("usage-missing-counters").usageMetadata).toEqual({})
    expect(fixture("go-away")).toEqual({ goAway: { timeLeft: "30s" } })
    const normal = fixture("input-repeat").serverContent.inputTranscription
    const extended = fixture("inert-optional-fields").serverContent
    expect(extended.inputTranscription.text).toBe(normal.text)
    expect(normal.text).toBe(" no no")
    expect(normal).not.toHaveProperty("finished")
    expect(normal).not.toHaveProperty("start_ms")
  })
