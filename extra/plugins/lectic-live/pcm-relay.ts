import type { PCMOutput } from "./provider"

type BrowserSocket = {
  readyState: number
  getBufferedAmount(): number
  send(data: string | Uint8Array): number
}

export function sendPCM(
  socket: BrowserSocket | undefined, output: PCMOutput, ready: boolean,
) {
  const data = output === "flush" ? '{"type":"flush"}' : output
  const size = typeof data === "string"
    ? Buffer.byteLength(data) : data.byteLength
  if (!socket || socket.readyState !== 1
    || (output !== "flush" && !ready)
    || socket.getBufferedAmount() + size > 192000
    || socket.send(data) === 0) {
    throw new Error("Browser audio unavailable or overloaded")
  }
}
