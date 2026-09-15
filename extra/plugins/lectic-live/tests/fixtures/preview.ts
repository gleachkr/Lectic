// Offline UI preview only: no credentials, microphone, or real Live API.
import { startServer } from "../../server"
import { LiveClient } from "../../live-client"

const server = startServer({
  connect: async () => {
    throw new Error("This preview cannot create a paid session")
  },
  backend: async () => ({ status: "completed", summary: "Offline fixture" }),
})
console.log(server.url)
process.on("SIGTERM", () => { void server.stop() })
process.on("SIGINT", () => { void server.stop() })
// Keep an explicit fake-client reference as a packaging smoke check.
new LiveClient({ send() {} }).disconnect()
