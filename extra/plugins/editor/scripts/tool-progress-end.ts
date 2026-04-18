#!/usr/bin/env -S lectic script

import { progressEnd } from "../lib"
import { presentToolProgressEnd } from "../presentation"

// give user time to read the message
await Bun.sleep(3000)

function requireEnv(name: string): string {
  const value = process.env[name]
  if (!value || value.trim() === "") {
    throw new Error(`${name} is required`)
  }
  return value
}

const token = requireEnv("TOOL_CALL_ID")
const toolName = requireEnv("TOOL_NAME")
const presentation = presentToolProgressEnd(
  toolName,
  process.env["TOOL_CALL_ERROR"],
  process.env["TOOL_DURATION_MS"]
)

await progressEnd({
  token,
  message: presentation.message,
})
