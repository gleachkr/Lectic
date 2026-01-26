import { isObjectRecord } from "../types/guards"
import type { ToolKitSpec } from "../types/lectic"

type MacroPreview = { description?: string, documentation: string }

type KitDocOpts = {
  descriptionLimit?: number
  toolsLimit?: number
  toolsSummaryLimit?: number
}

type MacroDocOpts = {
  documentationLimit?: number
}

export type DirectiveDoc = {
  key: string
  title: string
  body: string
  insert: string
  sortText?: string
  triggerSuggest?: boolean
}

export const DIRECTIVE_DOCS: DirectiveDoc[] = [
  {
    key: "cmd",
    title: "run a shell command and insert stdout",
    body:
      "Execute a command using the Bun shell and inline its stdout into " +
      "the message.",
    insert: ":cmd[${0:command}]",
    sortText: "01_cmd",
  },
  {
    key: "fetch",
    title: "fetch a URI or markdown link and inline its text",
    body:
      "Fetch the referenced content and inline it as <file ...> blocks. " +
      "Accepts either a plain URI/path (e.g. ./README.md) or a markdown " +
      "link/autolink (e.g. <https://...> or [t](./x)).",
    insert: ":fetch[${0:uri_or_link}]",
    sortText: "01_fetch",
  },
  {
    key: "env",
    title: "expand an environment variable",
    body:
      "Expand to the value of the named environment variable. The " +
      "expansion environment includes your process env, standard Lectic " +
      "variables (LECTIC_*), and any directive attributes.",
    insert: ":env[${0:VAR}]",
    sortText: "01_env",
  },
  {
    key: "verbatim",
    title: "return raw text without expanding nested macros",
    body:
      "Return the bracket content exactly as written. Nested directives " +
      "inside the brackets are not expanded.",
    insert: ":verbatim[${0:text}]",
    sortText: "01_verbatim",
  },
  {
    key: "once",
    title: "expand only in the most recent user message",
    body:
      "Expand the bracket content only when processing the most recent " +
      "user message. In older messages it expands to an empty string.",
    insert: ":once[${0:text}]",
    sortText: "01_once",
  },
  {
    key: "discard",
    title: "expand nested macros but discard the resulting text",
    body:
      "Expand the bracket content (including nested macros), then return " +
      "an empty string. Useful for side-effecting expansions like :attach.",
    insert: ":discard[${0:text}]",
    sortText: "01_discard",
  },
  {
    key: "attach",
    title: "attach verbatim inline text as an inline attachment",
    body:
      "Create an inline attachment whose content is exactly the text inside " +
      "the brackets. The attachment is treated as extra user context for the " +
      "next assistant turn.",
    insert: ":attach[${0:text}]",
    sortText: "01_attach",
  },
  {
    key: "reset",
    title: "clear prior conversation context for this turn",
    body: "Start this turn fresh. Previous history is not sent to the model.",
    insert: ":reset[]$0",
    sortText: "02_reset",
  },
  {
    key: "ask",
    title: "switch interlocutor for subsequent turns",
    body: "Permanently switch the active interlocutor until changed again.",
    insert: ":ask[$0]",
    sortText: "03_ask",
    triggerSuggest: true,
  },
  {
    key: "aside",
    title: "address one interlocutor for a single turn",
    body: "Temporarily switch interlocutor for just this user message.",
    insert: ":aside[$0]",
    sortText: "04_aside",
    triggerSuggest: true,
  },
  {
    key: "merge_yaml",
    title: "merge configuration into the header",
    body: "Merge the provided YAML into the document header configuration.",
    insert: ":merge_yaml[${0:yaml}]",
    sortText: "05_merge_yaml",
  },
  {
    key: "temp_merge_yaml",
    title: "temporarily merge configuration",
    body: "Merge the provided YAML into the header for this turn only.",
    insert: ":temp_merge_yaml[${0:yaml}]",
    sortText: "06_temp_merge_yaml",
  },
]

export function directiveDocFor(key: string): DirectiveDoc | null {
  const found = DIRECTIVE_DOCS.find(d => d.key === key)
  return found ?? null
}

export function trimText(s: string, n: number): string {
  return s.length <= n ? s : (s.slice(0, n - 1) + "…")
}

export function oneLine(s: string): string {
  return s.replace(/\s+/g, " ").trim()
}

function maxBacktickRun(s: string): number {
  let max = 0
  let run = 0

  for (const ch of s) {
    if (ch === '`') {
      run++
      if (run > max) max = run
    } else {
      run = 0
    }
  }

  return max
}

export function code(s: string): string {
  // Prefer a real Markdown code span (with a long enough delimiter) over
  // inserting zero-width characters.
  const fence = "`".repeat(maxBacktickRun(s) + 1)
  const body = (s.startsWith('`') || s.endsWith('`')) ? ` ${s} ` : s
  return fence + body + fence
}

export function codeFence(s: string): string {
  const fence = "`".repeat(Math.max(3, maxBacktickRun(s) + 1))
  return `${fence}\n${s}\n${fence}`
}

export function codeFenceLang(
  s: string,
  lang: string | null | undefined
): string {
  const fence = "`".repeat(Math.max(3, maxBacktickRun(s) + 1))
  const header = lang && lang.length > 0 ? fence + lang : fence
  return `${header}\n${s}\n${fence}`
}

export function formatKitDocsMarkdown(
  kit: ToolKitSpec,
  opts: KitDocOpts = {}
): string {
  const descLimit = opts.descriptionLimit ?? 1000
  const toolsLimit = opts.toolsLimit ?? 12
  const toolsSummaryLimit = opts.toolsSummaryLimit ?? 1000

  const parts: string[] = []
  parts.push(`kit ${code(kit.name)}`)

  if (kit.description) {
    parts.push(
      trimText(kit.description, descLimit)
    )
  }

  const toolsSummary = summarizeKitTools(kit.tools, toolsLimit)
  parts.push(`Tools (${kit.tools.length}):`)
  parts.push(codeFence(trimText(toolsSummary, toolsSummaryLimit)))

  return parts.join("\n\n")
}

export function formatMacroDocsMarkdown(
  macroName: string,
  preview: MacroPreview,
  opts: MacroDocOpts = {}
): string {
  const documentationLimit = opts.documentationLimit ?? 500

  const parts: string[] = []
  parts.push(`macro ${code(macroName)}`)

  if (preview.description) {
    parts.push(preview.description)
  }

  const snippet = trimText(preview.documentation, documentationLimit)
  parts.push(codeFence(snippet))

  return parts.join("\n\n")
}

function summarizeKitTools(tools: object[], max: number): string {
  const lines: string[] = []

  for (const t of tools.slice(0, max)) {
    lines.push(summarizeToolSpec(t))
  }

  const remaining = tools.length - Math.min(tools.length, max)
  if (remaining > 0) {
    lines.push(`… (${remaining} more)`)
  }

  return lines.length > 0 ? lines.join("\n") : "(no tools)"
}

function summarizeToolSpec(tool: object): string {
  if (!isObjectRecord(tool)) return "- (invalid tool spec)"
  const name = typeof tool["name"] === "string" ? tool["name"] : undefined

  const kind = TOOL_SPEC_KEYS.find(k => k in tool) ?? "tool"

  if (kind === "kit") {
    const kit = tool["kit"]
    if (typeof kit === "string") return `- kit: ${kit}`
  }
  if (kind === "agent") {
    const agent = tool["agent"]
    if (typeof agent === "string") return `- agent: ${agent}`
  }
  if (kind === "native") {
    const native = tool["native"]
    if (typeof native === "string") return `- native: ${native}`
  }

  if (name) return `- ${name} (${kind})`
  return `- ${kind}`
}

const TOOL_SPEC_KEYS = [
  "exec",
  "sqlite",
  "mcp_command",
  "mcp_ws",
  "mcp_shttp",
  "agent",
  "a2a",
  "think_about",
  "serve_on_port",
  "native",
  "kit",
]
