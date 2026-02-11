import { describe, expect, test } from "bun:test"

import { resolveNamedUses } from "./useResolver"

describe("resolveNamedUses", () => {
  test("resolves hook/env/sandbox use references", () => {
    const resolved = resolveNamedUses({
      hook_defs: [
        {
          name: "audit",
          on: "assistant_message",
          do: "echo audited",
        },
      ],
      env_defs: [
        {
          name: "shared_env",
          env: {
            MODE: "strict",
          },
        },
      ],
      sandbox_defs: [
        {
          name: "safe",
          sandbox: "bwrap --ro-bind / /",
        },
      ],
      sandbox: { use: "safe" },
      interlocutor: {
        name: "Assistant",
        prompt: "p",
        hooks: [{ use: "audit" }],
        tools: [
          {
            name: "shell",
            exec: "bash",
            env: { use: "shared_env" },
            sandbox: { use: "safe" },
            hooks: [{ use: "audit" }],
          },
        ],
      },
    }) as {
      sandbox: string
      interlocutor: {
        hooks: Array<{ do: string }>
        tools: Array<{
          env: Record<string, string>
          sandbox: string
          hooks: Array<{ do: string }>
        }>
      }
      hook_defs?: unknown
      env_defs?: unknown
      sandbox_defs?: unknown
    }

    expect(resolved.hook_defs).toBeUndefined()
    expect(resolved.env_defs).toBeUndefined()
    expect(resolved.sandbox_defs).toBeUndefined()

    expect(resolved.sandbox).toBe("bwrap --ro-bind / /")
    expect(resolved.interlocutor.hooks[0].do).toBe("echo audited")
    expect(resolved.interlocutor.tools[0].env["MODE"]).toBe("strict")
    expect(resolved.interlocutor.tools[0].sandbox).toBe("bwrap --ro-bind / /")
    expect(resolved.interlocutor.tools[0].hooks[0].do).toBe("echo audited")
  })

  test("throws deterministic error for unknown refs", () => {
    expect(() => {
      resolveNamedUses({
        interlocutor: {
          name: "Assistant",
          prompt: "p",
          hooks: [{ use: "missing" }],
        },
      })
    }).toThrow("Unknown hook definition: missing")

    expect(() => {
      resolveNamedUses({
        interlocutor: {
          name: "Assistant",
          prompt: "p",
          tools: [
            {
              name: "shell",
              exec: "bash",
              env: { use: "missing" },
            },
          ],
        },
      })
    }).toThrow("Unknown env definition: missing")

    expect(() => {
      resolveNamedUses({
        sandbox: { use: "missing" },
        interlocutor: {
          name: "Assistant",
          prompt: "p",
        },
      })
    }).toThrow("Unknown sandbox definition: missing")
  })
})
