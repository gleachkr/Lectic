import { remark } from "remark"
import remarkDirective from "remark-directive"
import type { RootContent } from "mdast"
import type { TextDirective } from "mdast-util-directive"
import { $ } from "bun"
import { type Macro } from "../types/macro"
import { lecticEnv } from "../utils/xdg"
import type { InlineAttachment } from "../types/inlineAttachment"
import { parseReferences, nodeContentRaw } from "./markdown"
import { MessageAttachment } from "../types/attachment"

const processor = remark().use(remarkDirective)

export type MacroMessageEnv = {
  MESSAGE_INDEX: number
  MESSAGES_LENGTH: number
}

function isFinalMessage(messageEnv?: MacroMessageEnv): boolean {
  return !!messageEnv && messageEnv.MESSAGE_INDEX === messageEnv.MESSAGES_LENGTH
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

  const first = node.children[0]
  const last = node.children[node.children.length - 1]

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

  const ref = refs[0]
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

export type MacroSideEffect =
  | { kind: "reset" }
  | { kind: "merge_yaml"; yaml: string }
  | { kind: "ask"; name: string }

export type MacroExpansionResult = {
  text: string
  inlineAttachments: InlineAttachment[]
  sideEffects: MacroSideEffect[]
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
  const hasBuiltin =
    /:(cmd|env|fetch|verbatim|once|discard|attach|ask|aside|reset|merge_yaml|temp_merge_yaml)\[/i
      .test(text)

  if (!hasMacros && !hasBuiltin) {
    return { text, inlineAttachments: [], sideEffects: [] }
  }

  const inlineAttachments: InlineAttachment[] = []
  const sideEffects: MacroSideEffect[] = []

  const expandTextInternal = async (
    raw: string,
    depth: number
  ): Promise<string> => {
    if (depth > 100) {
      throw new Error("Macro recursion depth limit exceeded")
    }

    const ast = processor.parse(raw)

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
        out.push(
          await expandNode(child, raw, childDepth)
        )
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

      const originalRaw = sliceNodeRaw(node, rawText)

      const attrsEnv = attrsToEnv(node.attributes)
      const baseEnv: Record<string, string | undefined> = {
        ...messageEnvToEnv(messageEnv),
        ...attrsEnv,
      }

      const content = directiveContentInfo(node, rawText)
      const argRaw = node.attributes?.["ARG"] ?? content.raw

      // Built-ins (pre)
      switch (nameLower) {
        case "verbatim": {
          return String(argRaw)
        }
        case "once": {
          if (!isFinalMessage(messageEnv)) return ""
          break
        }
        case "attach" : {
          // we skip expanding under attach if we're not on the final message
          if (!isFinalMessage(messageEnv)) return ""
          break
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
          return expandTextInternal(
            preResult,
            childDepth + 1
          )
        }
      }

      // Expand children (used for :attach, post macros, and for updating nested
      // macros inside unknown directives).
      let childrenExpanded = content.raw
      if (content.start !== null && content.end !== null) {
        childrenExpanded = await expandChildrenInRange(
          node.children,
          content.start,
          content.end,
          childDepth + 1
        )
      }

      // Built-ins (post)
      switch (nameLower) {
        case "env": {
          const envVar = childrenExpanded.trim()
          const env = {
            ...process.env,
            ...lecticEnv,
            ...baseEnv,
          } as Record<string, string | undefined>
          return env[envVar] ?? ""
        }
        case "cmd": {
          return builtinCmd(childrenExpanded)
        }
        case "fetch": {
          return builtinFetch(childrenExpanded)
        }
        case "attach" : {
          if (childrenExpanded.length > 0) {
            inlineAttachments.push({
              kind: "attach",
              command: "",
              content: childrenExpanded,
              mimetype: "text/plain",
            })
          }

          return ""
        }
        case "once" : {
          return childrenExpanded
        }
        case "discard" : {
          return ""
        }
        case "reset": {
          sideEffects.push({ kind: "reset" })
          return ""
        }
        case "merge_yaml": {
          sideEffects.push({
            kind: "merge_yaml",
            yaml: childrenExpanded,
          })
          return ""
        }
        case "temp_merge_yaml": {
          if (isFinalMessage(messageEnv)) {
            sideEffects.push({
              kind: "merge_yaml",
              yaml: childrenExpanded,
            })
          }
          return ""
        }
        case "ask": {
          sideEffects.push({
            kind: "ask",
            name: childrenExpanded.trim(),
          })
          return ""
        }
        case "aside": {
          if (isFinalMessage(messageEnv)) {
            sideEffects.push({
              kind: "ask",
              name: childrenExpanded.trim(),
            })
          }
          return ""
        }
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
        const dirStart = startOffset(node)
        const dirEnd = endOffset(node)

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
        return expandTextDirective(
          node,
          rawText,
          childDepth
        )
      }

      if ("children" in node) {
        
        if (node.children.length === 0) {
          return sliceNodeRaw(node, rawText)
        }

        return expandChildrenInRange(
          node.children,
          startOffset(node),
          endOffset(node),
          childDepth + 1
        )
      }

      return sliceNodeRaw(node, rawText)
    }

    return expandChildrenInRange(
      ast.children,
      0,
      raw.length,
      depth
    )
  }

  const out = await expandTextInternal(text, 0)

  // Preserve whether the input ended with a final newline.
  const inputHasFinalNL = /\r?\n$/.test(text)
  if (!inputHasFinalNL) {
    return {
      text: out.replace(/\r?\n$/, ""),
      inlineAttachments,
      sideEffects,
    }
  }

  return { text: out, inlineAttachments, sideEffects }
}
