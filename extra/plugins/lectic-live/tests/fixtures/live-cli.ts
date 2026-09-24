// Offline process fixture: real CLI/controller/adapter, loopback provider.
// This is never imported by the plugin and cannot open a paid connection.
import main from "../../lectic-live"

const endpoint = new URL(process.env["TEST_PROVIDER_URL"]!)
if (endpoint.protocol !== "ws:" || endpoint.hostname !== "127.0.0.1") {
  throw new Error("Expected a loopback test provider")
}
globalThis.WebSocket = class extends WebSocket {
  constructor() { super(endpoint) }
}

export default main
