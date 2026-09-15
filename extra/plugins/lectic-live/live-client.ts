import { randomUUID } from "node:crypto"
import { decodeEvent, type AppendKind, type LiveEvent } from "./protocol"

export interface WireTransport {
  send(raw: string): void
}

type Pending = {
  kind: AppendKind
  resolve(): void
  reject(error: Error): void
  timer: ReturnType<typeof setTimeout>
}

// Transport-independent sideband boundary. No connection or paid calls here.
export class LiveClient {
  private pending = new Map<string, Pending>()
  private disconnected = false

  constructor(private wire: WireTransport, private timeoutMs = 5000) {}

  append(kind: AppendKind, delegationId: string | null, content: string) {
    if (this.disconnected) return Promise.reject(new Error("Disconnected"))
    // Byte-level BPE has at most one token per UTF-8 byte. Leave headroom.
    if (!content.trim() || Buffer.byteLength(content) > 400) {
      return Promise.reject(new Error("Append exceeds conservative bound"))
    }
    if (this.pending.size >= 32) {
      return Promise.reject(new Error("Too many pending appends"))
    }
    const eventId = randomUUID()
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(eventId)
        reject(new Error("Append acknowledgment timed out; delivery unknown"))
      }, this.timeoutMs)
      this.pending.set(eventId, { kind, resolve, reject, timer })
      try {
        this.wire.send(JSON.stringify({
          type: `session.${kind}.append`, event_id: eventId,
          delegation_id: delegationId, content,
        }))
      } catch {
        this.settle(eventId, new Error("Send failed; delivery unknown"))
      }
    })
  }

  receive(raw: string): LiveEvent | null {
    if (this.disconnected) throw new Error("Disconnected")
    const event = decodeEvent(raw)
    if (!event) return null
    if (event.type === "error") {
      const eventId = event.error.client_event_id
      if (eventId) this.settle(eventId, new Error("Live rejected append"))
    } else if ("client_event_id" in event && event.client_event_id) {
      const pending = this.pending.get(event.client_event_id)
      if (pending && event.type === `session.${pending.kind}.appended`) {
        this.settle(event.client_event_id)
      }
    }
    return event
  }

  disconnect() {
    this.disconnected = true
    for (const id of this.pending.keys()) {
      this.settle(id, new Error("Disconnected; delivery unknown"))
    }
  }

  private settle(id: string, error?: Error) {
    const p = this.pending.get(id)
    if (!p) return
    clearTimeout(p.timer)
    this.pending.delete(id)
    if (error) p.reject(error)
    else p.resolve()
  }
}
