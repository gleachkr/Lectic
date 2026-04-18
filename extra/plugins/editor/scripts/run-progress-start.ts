#!/usr/bin/env -S lectic script

import { progressBegin } from "../lib"
import { presentRunProgressStart } from "../presentation"

function requireEnv(name: string): string {
  const value = process.env[name]
  if (!value || value.trim() === "") {
    throw new Error(`${name} is required`)
  }
  return value
}

const token = requireEnv("RUN_ID")
const presentation = presentRunProgressStart(process.env["RUN_CWD"])

await progressBegin({
  token,
  title: presentation.title,
  message: presentation.message,
})
