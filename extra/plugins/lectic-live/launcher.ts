import { spawn } from "node:child_process"

// A shell waits for the command inside $(...) to exit, not merely for EOF.
// Keep the controller in its own process group when stdout is redirected.
export async function launchController(command: string[], args: string[]) {
  const child = spawn(command[0], [...command.slice(1), ...args], {
    detached: true, stdio: ["ignore", "pipe", "inherit"],
  })
  try {
    const url = await new Promise<string>((resolve, reject) => {
      let output = ""
      const timer = setTimeout(() => {
        reject(new Error("Live controller startup timed out"))
      }, 30_000)
      const cleanup = () => { clearTimeout(timer) }
      child.once("error", error => { cleanup(); reject(error) })
      child.once("exit", code => {
        cleanup()
        reject(new Error(`Live controller exited before startup (${code})`))
      })
      child.stdout!.on("data", (chunk: Buffer) => {
        output += chunk.toString("utf8")
        if (output.length > 4096) {
          cleanup()
          reject(new Error("Invalid Live controller startup output"))
        } else if (output.includes("\n")) {
          cleanup()
          const line = output.trim()
          if (!/^http:\/\/127\.0\.0\.1:\d+\/#\w{64}$/.test(line)) {
            reject(new Error("Invalid Live controller URL"))
          } else resolve(line)
        }
      })
    })
    child.unref()
    return url
  } catch (error) {
    if (child.pid) {
      try { process.kill(-child.pid, "SIGTERM") } catch { /* Already gone. */ }
    }
    throw error
  } finally {
    child.stdout!.destroy()
  }
}
