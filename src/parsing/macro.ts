import { remark } from "remark"
import remarkDirective from "remark-directive"
import type { Image, Link, Parent, Root, RootContent } from "mdast"
import type { TextDirective } from "mdast-util-directive"
import { $ } from "bun"
import { Macro } from "../types/macro"
import { lecticEnv } from "../utils/xdg"
import type { InlineAttachment } from "../types/inlineAttachment"
import { parseReferences, nodeContentRaw } from "./markdown"
import { MessageAttachment } from "../types/attachment"

const processor = remark().use(remarkDirective)

const skipped = new Set([
  "ask",
  "aside",
  "reset",
  "merge_yaml",
  "temp_merge_yaml",
])

export type MacroMessageEnv = {
  MESSAGE_INDEX: number
  MESSAGES_LENGTH: number
}

function isFinalMessage(messageEnv?: MacroMessageEnv): boolean {
  return !!messageEnv && messageEnv.MESSAGE_INDEX === messageEnv.MESSAGES_LENGTH
}

function skipDirective(node: TextDirective, messageEnv?: MacroMessageEnv) {
  const nameLower = node.name.toLowerCase()

  // Don't expand under reserved directives.
  if (skipped.has(nameLower)) return true

  // Don't expand under :attach, unless we're processing the final message.
  // This prevents re-running attachment macros from older messages.
  if (nameLower === "attach" && !isFinalMessage(messageEnv)) {
    return true
  }

  return false
}

function offsetOrThrow(
  offset: number | undefined,
  ctx: string
): number {
  if (typeof offset !== "number") {
    throw new Error(`Missing position offset for ${ctx}`)
  }
  return offset
}

function startOffset(node: RootContent): number {
  return offsetOrThrow(node.position?.start.offset, node.type)
}

function endOffset(node: RootContent): number {
  return offsetOrThrow(node.position?.end.offset, node.type)
}

function sliceNodeRaw(node: RootContent, raw: string): string {
  const start = startOffset(node)
  const end = endOffset(node)
  return raw.slice(start, end)
}

type DirectiveContentInfo = {
  raw: string
  start: number | null
  end: number | null
}

function directiveContentInfo(
  node: TextDirective,
  raw: string
): DirectiveContentInfo {
  if (node.children.length === 0) {
    return { raw: "", start: null, end: null }
  }

  const first = node.children[0] as RootContent
  const last = node.children[node.children.length - 1] as RootContent

  const start = startOffset(first)
  const end = endOffset(last)
  return { raw: raw.slice(start, end), start, end }
}

function attrsToEnv(
  attrs: Record<string, string | null | undefined> | null | undefined
): Record<string, string | undefined> {
  if (!attrs) return {}

  const out: Record<string, string | undefined> = {}
  for (const [k, v] of Object.entries(attrs)) {
    out[k] = v === null ? "" : v
  }
  return out
}

function messageEnvToEnv(messageEnv?: MacroMessageEnv): Record<string, string> {
  if (!messageEnv) return {}

  return {
    MESSAGE_INDEX: String(messageEnv.MESSAGE_INDEX),
    MESSAGES_LENGTH: String(messageEnv.MESSAGES_LENGTH),
  }
}

function escapeXmlAttr(raw: string): string {
  return raw.replace(/&/g, "&amp;").replace(/"/g, "&quot;")
}

type FetchTarget = {
  uri: string
  title: string
}

function parseFetchTarget(raw: string): FetchTarget | null {
  const refs = parseReferences(raw)

  if (refs.length === 0) {
    const uri = raw.trim()
    if (uri.length === 0) return null
    return { uri, title: uri }
  }

  if (refs.length !== 1) {
    throw new Error(
      `:fetch[...] expects exactly one markdown link, got ${refs.length}`
    )
  }

  const ref = refs[0] as Link | Image
  const uri = ref.url
  if (typeof uri !== "string" || uri.length === 0) return null

  const title = ref.type === "link"
    ? nodeContentRaw(ref, raw)
    : (ref.alt ?? "")

  return { uri, title: title.length > 0 ? title : uri }
}

function isTextLikeMime(mt: string | null | undefined): boolean {
  if (!mt) return false
  if (mt === "text/plain") return true
  if (mt === "application/json") return true
  if (mt.endsWith("+json")) return true
  if (mt === "application/xml") return true
  if (mt.endsWith("+xml")) return true
  return false
}

async function builtinFetch(bodyRaw: string): Promise<string> {
  const target = parseFetchTarget(bodyRaw)
  if (!target) {
    return "<error>:fetch requires a URI or markdown link</error>"
  }

  const atts = MessageAttachment.fromGlob({
    text: target.title,
    URI: target.uri,
  })

  const out: string[] = []

  for (const att of atts) {
    if (!(await att.exists())) {
      out.push(
        `<error>Could not fetch ${escapeXmlAttr(att.URI)}: not found</error>`
      )
      continue
    }

    const parts = await att.getParts()
    if (parts.length === 0) {
      out.push(
        `<error>Could not fetch ${escapeXmlAttr(att.URI)}: empty result</error>`
      )
      continue
    }

    for (const part of parts) {
      const mt = part.mimetype
      if (!isTextLikeMime(mt)) {
        const shown = mt ?? "unknown"
        out.push(
          `<error>Media type ${shown} is not supported by :fetch. ` +
            `Use a markdown link instead.</error>`
        )
        continue
      }

      const titleAttr = escapeXmlAttr(part.title)
      const uriAttr = escapeXmlAttr(part.URI)
      const typeAttr = mt ? ` type="${escapeXmlAttr(mt)}"` : ""
      const text = Buffer.from(part.bytes).toString()
      out.push(
        `<file title="${titleAttr}" uri="${uriAttr}"${typeAttr}>` +
          `${text}</file>`
      )
    }
  }

  return out.join("\n")
}

async function builtinCmd(cmdTextRaw: string): Promise<string> {
  // Execute the bracket content as a Bun shell command.
  // Newlines are ignored so wrapped commands don't change meaning.
  const cmdText = cmdTextRaw.trim().replace(/[\n\r]+/g, "")

  // NOTE: Bun's `$` supports { raw: string } as an undocumented escape hatch
  // for inserting an unescaped string.
  const rawCmd = { raw: cmdText }
  const result = await $`${rawCmd}`.nothrow().quiet()

  // XML attribute escaping
  const fromAttr = escapeXmlAttr(cmdText)

  if (result.exitCode === 0) {
    return (
      `<stdout from="${fromAttr}">` +
      `${result.stdout.toString()}</stdout>`
    )
  }

  return (
    `<error>Something went wrong when executing a command:` +
    `<stdout from="${fromAttr}">` +
    `${result.stdout.toString()}</stdout>` +
    `<stderr from="${fromAttr}">` +
    `${result.stderr.toString()}</stderr>` +
    `</error>`
  )
}

export type MacroExpansionResult = {
  text: string
  inlineAttachments: InlineAttachment[]
}

export async function expandMacros(
  text: string,
  macros: Record<string, Macro>,
  messageEnv?: MacroMessageEnv
): Promise<string> {
  const res = await expandMacrosWithAttachments(text, macros, messageEnv)
  return res.text
}

export async function expandMacrosWithAttachments(
  text: string,
  macros: Record<string, Macro>,
  messageEnv?: MacroMessageEnv
): Promise<MacroExpansionResult> {
  const hasMacros = Object.keys(macros).length > 0
  const hasBuiltin = /:(cmd|env|fetch|verbatim|once|discard|clear)\[/i.test(text)
  const mayHaveAttach = isFinalMessage(messageEnv) && /:attach\[/i.test(text)

  if (!hasMacros && !hasBuiltin && !mayHaveAttach) {
    return { text, inlineAttachments: [] }
  }

  const inlineAttachments: InlineAttachment[] = []

  const expandTextInternal = async (
    raw: string,
    depth: number
  ): Promise<string> => {
    if (depth > 100) {
      throw new Error("Macro recursion depth limit exceeded")
    }

    const ast = processor.parse(raw) as Root

    const expandChildrenInRange = async (
      children: RootContent[],
      rangeStart: number,
      rangeEnd: number,
      childDepth: number
    ): Promise<string> => {
      const out: string[] = []
      let cursor = rangeStart

      for (const child of children) {
        const start = startOffset(child)
        const end = endOffset(child)

        if (start < cursor) {
          throw new Error("AST node positions are out of order")
        }

        out.push(raw.slice(cursor, start))
        out.push(await expandNode(child, raw, childDepth))
        cursor = end
      }

      out.push(raw.slice(cursor, rangeEnd))
      return out.join("")
    }

    const expandTextDirective = async (
      node: TextDirective,
      rawText: string,
      childDepth: number
    ): Promise<string> => {
      const nameLower = node.name.toLowerCase()

      if (skipDirective(node, messageEnv)) {
        if (nameLower === "attach") {
            return ""
        } else {
            return sliceNodeRaw(node as unknown as RootContent, rawText)
        }
      }

      const originalRaw = sliceNodeRaw(node as unknown as RootContent, rawText)

      const attrsEnv = attrsToEnv(node.attributes)
      const baseEnv: Record<string, string | undefined> = {
        ...messageEnvToEnv(messageEnv),
        ...attrsEnv,
      }

      const content = directiveContentInfo(node, rawText)
      const argRaw = node.attributes?.["ARG"] ?? content.raw

      // Built-ins (pre)
      switch (nameLower) {
        case "env": {
          const envVar = String(argRaw).trim()
          const env = {
            ...process.env,
            ...lecticEnv,
            ...baseEnv,
          } as Record<string, string | undefined>
          return env[envVar] ?? ""
        }
        case "cmd": {
          return await builtinCmd(String(argRaw))
        }
        case "fetch": {
          const hasArgAttr = node.attributes?.["ARG"] != null
          const body = hasArgAttr
            ? String(argRaw)
            : (content.start !== null && content.end !== null)
              ? await expandChildrenInRange(
                node.children as RootContent[],
                content.start,
                content.end,
                childDepth + 1
              )
              : ""

          return await builtinFetch(body)
        }
        case "verbatim": {
          return String(argRaw)
        }
        case "once": {
          if (!isFinalMessage(messageEnv)) return ""
          if (content.start === null || content.end === null) return ""
          return await expandChildrenInRange(
            node.children as RootContent[],
            content.start,
            content.end,
            childDepth + 1
          )
        }
      }

      const macro = macros[nameLower]

      // Macro pre
      if (macro && macro.pre) {
        const preEnv: Record<string, string | undefined> = {
          ...baseEnv,
          ARG: String(argRaw),
        }

        const preResult = await macro.expandPre(preEnv)
        if (preResult !== undefined) {
          return await expandTextInternal(preResult, childDepth + 1)
        }
      }

      // Expand children (used for :attach, post macros, and for updating nested
      // macros inside unknown directives).
      let childrenExpanded = content.raw
      if (content.start !== null && content.end !== null) {
        childrenExpanded = await expandChildrenInRange(
          node.children as RootContent[],
          content.start,
          content.end,
          childDepth + 1
        )
      }

      // :attach (special)
      if (nameLower === "attach") {
        if (isFinalMessage(messageEnv)) {
          inlineAttachments.push({
            kind: "attach",
            command: "",
            content: childrenExpanded,
            mimetype: "text/plain",
          })
        }

        return ""
      }

      // Built-ins (post)
      if (nameLower === "discard") {
        return ""
      }

      // Macro post
      if (macro && macro.post) {
        const postEnv: Record<string, string | undefined> = {
          ...baseEnv,
          ARG: node.attributes?.["ARG"] ?? childrenExpanded,
        }

        const postResult = await macro.expandPost(postEnv)
        if (postResult !== undefined) {
          return postResult
        }
      }

      // Default: keep directive syntax, but allow expansions inside the
      // bracket content.
      if (
        content.start !== null &&
        content.end !== null &&
        childrenExpanded !== content.raw
      ) {
        const dirStart = startOffset(node as unknown as RootContent)
        const dirEnd = endOffset(node as unknown as RootContent)

        return (
          rawText.slice(dirStart, content.start) +
          childrenExpanded +
          rawText.slice(content.end, dirEnd)
        )
      }

      return originalRaw
    }

    const expandNode = async (
      node: RootContent,
      rawText: string,
      childDepth: number
    ): Promise<string> => {
      if (childDepth > 100) {
        throw new Error("Macro recursion depth limit exceeded")
      }

      if (node.type === "containerDirective") {
        return sliceNodeRaw(node, rawText)
      }

      if (node.type === "textDirective") {
        return await expandTextDirective(
          node as unknown as TextDirective,
          rawText,
          childDepth
        )
      }

      if ("children" in node) {
        const parent = node as Parent
        if (parent.children.length === 0) {
          return sliceNodeRaw(node, rawText)
        }

        const start = startOffset(node)
        const end = endOffset(node)
        return await expandChildrenInRange(
          parent.children as RootContent[],
          start,
          end,
          childDepth + 1
        )
      }

      return sliceNodeRaw(node, rawText)
    }

    return await expandChildrenInRange(ast.children, 0, raw.length, depth)
  }

  const out = await expandTextInternal(text, 0)

  // Preserve whether the input ended with a final newline.
  const inputHasFinalNL = /\r?\n$/.test(text)
  if (!inputHasFinalNL) {
    return {
      text: out.replace(/\r?\n$/, ""),
      inlineAttachments,
    }
  }

  return { text: out, inlineAttachments }
}
