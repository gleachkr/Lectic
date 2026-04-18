#!/usr/bin/env -S lectic script

import { approve } from "../lib"
import { presentToolApproval } from "../presentation"

function requireEnv(name: string): string {
  const value = process.env[name]
  if (!value || value.trim() === "") {
    throw new Error(`${name} is required`)
  }
  return value
}

const toolName = requireEnv("TOOL_NAME")
const presentation = presentToolApproval(toolName, process.env["TOOL_ARGS"])
const allowed = await approve(presentation)

process.exit(allowed ? 0 : 1)
