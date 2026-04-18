#!/usr/bin/env -S lectic script

import { progressBegin } from "../lib"
import { presentToolProgressStart } from "../presentation"

function requireEnv(name: string): string {
  const value = process.env[name]
  if (!value || value.trim() === "") {
    throw new Error(`${name} is required`)
  }
  return value
}

const token = requireEnv("TOOL_CALL_ID")
const toolName = requireEnv("TOOL_NAME")
const presentation = presentToolProgressStart(
  toolName,
  process.env["TOOL_ARGS"]
)

await progressBegin({
  token,
  title: presentation.title,
  message: presentation.message,
})
