// Deterministic provider substitution. The real CLI still handles stdin,
// discovery, imports, initialization, macro processing, output and signals.
// Only tests import core internals; distributed plugin modules do not.
import { mock } from "bun:test"
import type { Lectic } from "../../../../../src/types/lectic"
import { serializeThoughtBlock }
  from "../../../../../src/types/thought"
import { serializeInlineAttachment }
  from "../../../../../src/types/inlineAttachment"
import { writeFileSync } from "node:fs"

mock.module("../../../../../src/backends/util", () => ({
  getBackend: () => ({
    async *evaluate(lectic: Lectic) {
      const capture = process.env["SPIKE_CAPTURE"]
      if (capture) writeFileSync(capture, JSON.stringify({
        cwd: process.cwd(),
        prompt: lectic.header.interlocutor.prompt,
        model: lectic.header.interlocutor.model,
        speaker: lectic.header.interlocutor.name,
        messages: lectic.body.messages.map(m => ({
          role: m.role, content: m.content,
          links: m.role === "user" ? m.containedLinks() : [],
          directives: m.role === "user" ? m.containedDirectives() : [],
        })),
      }))
      const mode = process.env["SPIKE_MODE"]
      if (mode === "throw") throw new Error("Provider failure")
      if (mode === "writable-tool") {
        const tool = lectic.header.interlocutor.registry?.["repository_shell"]
        if (!tool) throw new Error("Missing configured tool")
        const results = await tool.call({ argv: ["-c",
          "printf written > evidence.txt; cat evidence.txt",
        ] })
        const text = results.map(r => r.content).join("\n")
        if (!text.includes("written")) {
          throw new Error("Configured tool did not write the file")
        }
        yield '```lectic-live-result\n' + JSON.stringify({
          status: "completed", summary: "Wrote evidence.txt.",
        }) + "\n```\n\n"
        return
      }
      yield "Intermediate assistant prose.\n\n"
      yield serializeThoughtBlock({ content: ["PRIVATE THOUGHT"] }) + "\n\n"
      yield serializeInlineAttachment({
        kind: "hook", command: "test-hook",
        content: "PRIVATE HOOK OUTPUT", attributes: { final: "false" },
      }) + "\n\n"
      // A candidate final pass followed by another inline hook is not final.
      yield '```lectic-live-result\n'
        + '{"status":"completed","summary":"EARLY ANSWER"}\n```\n\n'
      yield serializeInlineAttachment({
        kind: "hook", command: "test-follow-up", content: "Continue",
        attributes: { final: "false" },
      }) + "\n\n"
      if (mode === "slow") await Bun.sleep(60_000)
      if (mode === "zero-error") {
        yield "<error>Runaway tool use!</error>\n\n"
      } else if (mode === "malformed") {
        yield "This is not a result envelope.\n\n"
      } else {
        yield '```lectic-live-result\n'
          + '{"status":"completed","summary":"The answer is 42."}\n```\n\n'
      }
    },
  }),
}))

const entrypoint = new URL("../../../../../src/main.ts", import.meta.url)
await import(entrypoint.href)
