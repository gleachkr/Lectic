#!/usr/bin/env -S lectic script

import { progressEnd } from "../lib"
import { presentRunProgressEnd } from "../presentation"

function requireEnv(name: string): string {
  const value = process.env[name]
  if (!value || value.trim() === "") {
    throw new Error(`${name} is required`)
  }
  return value
}

const token = requireEnv("RUN_ID")
const presentation = presentRunProgressEnd(
  process.env["RUN_STATUS"],
  process.env["RUN_ERROR_MESSAGE"],
  process.env["RUN_DURATION_MS"]
)

await progressEnd({
  token,
  message: presentation.message,
})
