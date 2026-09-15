import { expect, test } from "bun:test"
import {
  createRequest, decodeCreated, decodeEvent, MAX_EVENT_BYTES,
} from "../protocol"
import { LiveClient } from "../live-client"
import events from "./fixtures/events.json"

test("documented fixtures preserve exact deltas and opaque delegation IDs",
  () => {
    const parsed = events.map(e => decodeEvent(JSON.stringify(e)))
    expect(parsed[2]).toMatchObject({ delta: " the answer?" })
    expect(parsed[3]).toMatchObject({
      offset_ms: 1400, delegation: { id: "opaque/id:☃", target: "client" },
    })
    expect(parsed[3]).not.toHaveProperty("request")
  })

test("creation denies all frontend commands and uses object selectors",
  () => {
    const request = createRequest("offer")
    expect(request.session.model).toBe("gpt-live-1")
    expect(request.session.store).toBe(false)
    expect(request.session.client.data_channel.allowed_client_events)
      .toEqual([])
    expect(request.session.client.data_channel.allowed_server_events)
      .toContainEqual({ type: "session.delegation.created" })
    expect(request.session).not.toHaveProperty("audio")
    expect(decodeCreated({
      session: { id: "opaque/session" },
      transport: { type: "webrtc", sdp: "answer" },
    })).toEqual({ sessionId: "opaque/session", sdp: "answer" })
    expect(() => decodeCreated({ session: { id: "x" } })).toThrow()
  })

test("malformed supported events fail, unknown and reflected audio are inert",
  () => {
    for (const bad of [
      null, [], { type: "session.delegation.created", request: "invented" },
      { ...events[0], start_ms: -1 }, { ...events[0], end_ms: 0 },
      { ...events[0], delta: 42 },
      { type: "session.usage.updated", usage: { seconds: "12" } },
    ]) expect(() => decodeEvent(JSON.stringify(bad))).toThrow()
    expect(() => decodeEvent("x".repeat(MAX_EVENT_BYTES + 1))).toThrow()
    expect(decodeEvent('{"type":"session.input_audio.append"}')).toBeNull()
    expect(decodeEvent('{"type":"future.event"}')).toBeNull()
  })

test("usage and finalization retain cumulative seconds, reason and ownership",
  () => {
    expect(decodeEvent(JSON.stringify({
      type: "session.usage.updated", usage: { seconds: 12 },
      context_window: { usage_ratio: 0.42 },
    }))).toEqual({
      type: "session.usage.updated", usage: { seconds: 12 },
    })
    expect(decodeEvent(JSON.stringify({
      type: "session.closed", session: { id: "s" },
      usage: { seconds: 15 }, reason: "connection_lost",
    }))).toMatchObject({ session: { id: "s" }, reason: "connection_lost" })
  })

test("ack correlation is registered before send and does not imply speech",
  async () => {
    const sent: any[] = []
    const client = new LiveClient({
      send(raw) { sent.push(JSON.parse(raw)) },
    })
    const result = client.append("commentary", "opaque", "Found it.")
    const outgoing = sent[0]
    expect(outgoing.delegation_id).toBe("opaque")
    expect(outgoing.type).toBe("session.commentary.append")
    let acknowledged = false
    void result.then(() => { acknowledged = true })
    client.receive(JSON.stringify({
      type: "session.thinking.appended", client_event_id: outgoing.event_id,
    }))
    await Bun.sleep(1)
    expect(acknowledged).toBe(false)
    client.receive(JSON.stringify({
      type: "session.commentary.appended", client_event_id: outgoing.event_id,
    }))
    await result
    expect(acknowledged).toBe(true)
    expect(sent).toHaveLength(1)
    client.disconnect()
  })

test("synchronous acknowledgment is not lost", async () => {
  const client = new LiveClient({ send(raw) {
    const outgoing = JSON.parse(raw)
    client.receive(JSON.stringify({
      type: "session.thinking.appended", client_event_id: outgoing.event_id,
    }))
  } })
  await client.append("thinking", null, "Verified status.")
  client.disconnect()
})

test("nested error correlation, timeout, and disconnect never resend",
  async () => {
    const sent: any[] = []
    const client = new LiveClient({
      send(raw) { sent.push(JSON.parse(raw)) },
    }, 20)
    const rejected = client.append("commentary", "d", "Result")
    client.receive(JSON.stringify({
      type: "error", error: {
        message: "Rejected", code: null, client_event_id: sent[0].event_id,
      },
    }))
    await expect(rejected).rejects.toThrow("rejected")
    await expect(client.append("thinking", null, "Status"))
      .rejects.toThrow("delivery unknown")
    const pending = client.append("commentary", "d", "Another result")
    client.disconnect()
    await expect(pending).rejects.toThrow("delivery unknown")
    expect(sent).toHaveLength(3)
    await expect(client.append("thinking", null, "Status"))
      .rejects.toThrow("Disconnected")
  })

test("append bound is bytes rather than characters, including Unicode",
  async () => {
    const client = new LiveClient({
      send() { throw new Error("not connected") },
    })
    await expect(client.append("commentary", "d", "☃".repeat(134)))
      .rejects.toThrow("bound")
    await expect(client.append("commentary", "d", "a".repeat(401)))
      .rejects.toThrow("bound")
    await expect(client.append("commentary", "d", "雪".repeat(100)))
      .rejects.toThrow("Send failed")
    client.disconnect()
  })
