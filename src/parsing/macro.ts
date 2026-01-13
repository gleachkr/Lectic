import { remark } from "remark"
import remarkDirective from "remark-directive"
import type { Parent, PhrasingContent, Root, RootContent, Text } from "mdast"
import type { TextDirective } from "mdast-util-directive"
import { $ } from "bun"
import { Macro } from "../types/macro"
import type { InlineAttachment } from "../types/inlineAttachment"

const processor = remark().use(remarkDirective)

function nodesToMarkdown(nodes: RootContent[]): string {
  const root: Root = { type: "root", children: nodes }
  let out = processor.stringify(root)

  // remark.stringify adds a trailing newline if there are children.
  if (nodes.length > 0) {
    out = out.replace(/\r?\n$/, "")
  }

  return out
}

export async function expandMacros(
  text: string,
  macros: Record<string, Macro>,
  messageEnv?: MacroMessageEnv
): Promise<string> {
  const res = await expandMacrosWithAttachments(text, macros, messageEnv)
  return res.text
}

const skipped = new Set([
  "ask",
  "aside",
  "reset",
  "merge_yaml",
  "temp_merge_yaml",
])

const builtin = new Set(["cmd"])

export type MacroMessageEnv = {
  MESSAGE_INDEX: number
  MESSAGES_LENGTH: number
}

function skipDirective(node: TextDirective, messageEnv?: MacroMessageEnv) {
  const nameLower = node.name.toLowerCase()

  // Don't expand under reserved directives.
  if (skipped.has(nameLower)) return true

  // Don't expand under :attach, unless we're processing the final message.
  // This prevents re-running attachment macros from older messages.
  if (
    nameLower === "attach" &&
    (!messageEnv || messageEnv.MESSAGE_INDEX !== messageEnv.MESSAGES_LENGTH)
  ) {
    return true
  }

  return false
}

async function handleBuiltin(node: TextDirective): Promise<Text> {
  let value = ""

  switch (node.name.toLowerCase()) {
    case "cmd": {
      // Execute the bracket content as a Bun shell command.
      // Newlines are ignored so wrapped commands don't change meaning.
      const cmdText = nodesToMarkdown(node.children)
        .trim()
        .replace(/[\n\r]+/g, "")

      // NOTE: Bun's `$` supports { raw: string } as an undocumented escape
      // hatch for inserting an unescaped string.
      const rawCmd = { raw: cmdText }
      const result = await $`${rawCmd}`.nothrow().quiet()

      // HTML escaping
      const fromAttr = cmdText.replace(/&/g, "&amp;").replace(/"/g, "&quot;")

      if (result.exitCode === 0) {
        value = `<stdout from="${fromAttr}">` +
          `${result.stdout.toString()}</stdout>`
      } else {
        value = `<error>Something went wrong when executing a command:` +
          `<stdout from="${fromAttr}">` +
          `${result.stdout.toString()}</stdout>` +
          `<stderr from="${fromAttr}">` +
          `${result.stderr.toString()}</stderr>` +
          `</error>`
      }

      break
    }
  }

  return { type: "text", value }
}

export type MacroExpansionResult = {
  text: string
  inlineAttachments: InlineAttachment[]
}

function isFinalMessage(messageEnv?: MacroMessageEnv): boolean {
  return !!messageEnv && messageEnv.MESSAGE_INDEX === messageEnv.MESSAGES_LENGTH
}

export async function expandMacrosWithAttachments(
  text: string,
  macros: Record<string, Macro>,
  messageEnv?: MacroMessageEnv
): Promise<MacroExpansionResult> {
  const hasMacros = Object.keys(macros).length > 0
  const hasBuiltin = /:cmd\[/i.test(text)
  const mayHaveAttach = isFinalMessage(messageEnv) && /:attach\[/i.test(text)

  if (!hasMacros && !hasBuiltin && !mayHaveAttach) {
    return { text, inlineAttachments: [] }
  }

  const inlineAttachments: InlineAttachment[] = []

  const ast = processor.parse(text)
  let changed = false

  async function walk(
    node: RootContent,
    raw: string,
    depth = 0
  ): Promise<RootContent[]> {
    if (depth > 100) throw new Error("Macro recursion depth limit exceeded")

    if (node.type === "containerDirective") {
      return [node]
    }

    if (node.type === "textDirective") {
      const nameLower = node.name.toLowerCase()

      if (nameLower === "attach") {
        if (!isFinalMessage(messageEnv)) return [node]

        changed = true

        const newChildren: RootContent[] = []
        for (const child of node.children) {
          newChildren.push(...await walk(child, raw, depth + 1))
        }

        inlineAttachments.push({
          kind: "attach",
          command: "",
          content: nodesToMarkdown(newChildren),
          mimetype: "text/plain",
        })

        return [{ type: "text", value: "" }]
      }

      if (skipDirective(node, messageEnv)) return [node]


      if (builtin.has(nameLower)) {
        changed = true
        return [await handleBuiltin(node)]
      }

      const macro = macros[nameLower]
      if (macro) {
        changed = true

        const env: Record<string, string | undefined> = {
          ...Object.fromEntries(
            Object.entries(messageEnv ?? {}).map(([k, v]) => [k, String(v)])
          ),
          ...node.attributes,
          ARG: node.attributes?.["ARG"] ?? nodesToMarkdown(node.children),
        }

        const preResult = await macro.expandPre(env)
        if (preResult !== undefined) {
          const parsed = processor.parse(preResult).children
          const processed: RootContent[] = []

          for (const n of parsed) {
            processed.push(...await walk(n, preResult, depth + 1))
          }

          if (processed.length > 0) return processed

          // If parsing returned no nodes (e.g. empty comment), return empty
          // text node.
          return [{ type: "text", value: "" }]
        }

        // Pre didn't return (or returned empty), so process children.
        const newChildren: RootContent[] = []
        for (const child of node.children) {
          newChildren.push(...await walk(child, raw, depth + 1))
        }

        // We need to cast here, since technically an inline directive's
        // children must be phrasing content.
        node.children = newChildren as PhrasingContent[]

        // Update ARG with processed children.
        env["ARG"] = node.attributes?.["ARG"] ?? nodesToMarkdown(node.children)

        const postResult = await macro.expandPost(env)
        if (postResult !== undefined) {
          const parsed = processor.parse(postResult).children
          const processed: RootContent[] = []

          for (const n of parsed) {
            processed.push(...await walk(n, postResult, depth + 1))
          }

          if (processed.length > 0) return processed
          return [{ type: "text", value: "" }]
        }
      }
    }

    if ("children" in node) {
      const parent = node as Parent
      const newChildren: RootContent[] = []

      for (const child of parent.children) {
        newChildren.push(...await walk(child, raw, depth))
      }

      parent.children = newChildren
    }

    return [node]
  }

  const newChildren: RootContent[] = []
  for (const child of ast.children) {
    newChildren.push(...await walk(child, text))
  }
  ast.children = newChildren

  if (!changed) {
    return { text, inlineAttachments }
  }


  let out = processor.stringify(ast)
  const inputHasFinalNL = /\r?\n$/.test(text)
  if (!inputHasFinalNL) out = out.replace(/\r?\n$/, "")
  return { text: out, inlineAttachments }
}
