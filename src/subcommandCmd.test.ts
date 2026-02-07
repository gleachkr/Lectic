import { describe, expect, test } from "bun:test"
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from "fs"
import { tmpdir } from "os"
import { join } from "path"

import { resolveSubcommandPath } from "./subcommandCmd"

describe("subcommand resolution", () => {
  test("finds commands recursively in LECTIC_CONFIG-like directory", () => {
    const root = mkdtempSync(join(tmpdir(), "lectic-subcmd-config-"))
    const configDir = join(root, "config")
    const nested = join(configDir, "plugins", "shared", "bin")
    const cmd = join(nested, "lectic-hello")

    try {
      mkdirSync(nested, { recursive: true })
      writeFileSync(cmd, "#!/bin/sh\necho hi\n")
      chmodSync(cmd, 0o755)

      const result = resolveSubcommandPath("hello", [
        { dir: configDir, recursive: true },
      ])

      expect(result.kind).toBe("found")
      if (result.kind === "found") {
        expect(result.path).toBe(cmd)
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("finds commands recursively in LECTIC_DATA-like directory", () => {
    const root = mkdtempSync(join(tmpdir(), "lectic-subcmd-"))
    const dataDir = join(root, "data")
    const nested = join(dataDir, "plugins", "sales", "bin")
    const cmd = join(nested, "lectic-hello")

    try {
      mkdirSync(nested, { recursive: true })
      writeFileSync(cmd, "#!/bin/sh\necho hi\n")
      chmodSync(cmd, 0o755)

      const result = resolveSubcommandPath("hello", [
        { dir: dataDir, recursive: true },
      ])

      expect(result.kind).toBe("found")
      if (result.kind === "found") {
        expect(result.path).toBe(cmd)
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("respects directory precedence order", () => {
    const root = mkdtempSync(join(tmpdir(), "lectic-subcmd-priority-"))
    const configDir = join(root, "config")
    const dataDir = join(root, "data")

    const configCmd = join(configDir, "lectic-hello")
    const dataCmd = join(dataDir, "plugins", "sales", "lectic-hello")

    try {
      mkdirSync(configDir, { recursive: true })
      mkdirSync(join(dataDir, "plugins", "sales"), { recursive: true })

      writeFileSync(configCmd, "#!/bin/sh\necho config\n")
      writeFileSync(dataCmd, "#!/bin/sh\necho data\n")
      chmodSync(configCmd, 0o755)
      chmodSync(dataCmd, 0o755)

      const result = resolveSubcommandPath("hello", [
        { dir: configDir, recursive: false },
        { dir: dataDir, recursive: true },
      ])

      expect(result.kind).toBe("found")
      if (result.kind === "found") {
        expect(result.path).toBe(configCmd)
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("returns an error when multiple matches exist in same scope", () => {
    const root = mkdtempSync(join(tmpdir(), "lectic-subcmd-dup-"))
    const dataDir = join(root, "data")
    const one = join(dataDir, "a", "lectic-hello")
    const two = join(dataDir, "b", "lectic-hello")

    try {
      mkdirSync(join(dataDir, "a"), { recursive: true })
      mkdirSync(join(dataDir, "b"), { recursive: true })
      writeFileSync(one, "#!/bin/sh\n")
      writeFileSync(two, "#!/bin/sh\n")
      chmodSync(one, 0o755)
      chmodSync(two, 0o755)

      const result = resolveSubcommandPath("hello", [
        { dir: dataDir, recursive: true },
      ])

      expect(result.kind).toBe("error")
      if (result.kind === "error") {
        expect(result.message).toContain("multiple commands available")
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
