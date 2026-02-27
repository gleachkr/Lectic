import {
  escapeTags,
  unescapeTags,
  escapeXmlAttribute,
  unescapeXmlAttribute,
} from "../parsing/xml"
import { unwrap, extractElements } from "../parsing/xml"

export type InlineAttachment = {
  kind: "hook" | "attach"
  command: string
  content: string
  mimetype?: string // defaults to text/plain
  icon?: string
  attributes?: Record<string, string>
}

const INLINE_ATTACHMENT_DEFAULT_ICON: Record<InlineAttachment["kind"], string> = {
  hook: "󱐋",
  attach: "",
}

export function defaultInlineAttachmentIcon(
  kind: string
): string {
  return (kind === "hook" || kind === "attach") 
      ? INLINE_ATTACHMENT_DEFAULT_ICON[kind]
      : "?"
}

export function serializeInlineAttachment(a: InlineAttachment): string {
  const type = a.mimetype ?? "text/plain"
  const cmdXml = `<command>${escapeTags(a.command)}</command>`
  const contentXml = `<content type="${type}">${escapeTags(a.content)}</content>`

  const attrs = { ...(a.attributes ?? {}) }
  const icon =
    a.icon ?? attrs["icon"] ?? defaultInlineAttachmentIcon(a.kind)
  delete attrs["icon"]

  let attrStr =
    `kind="${escapeXmlAttribute(a.kind)}" ` +
    `icon="${escapeXmlAttribute(icon)}"`

  for (const [key, val] of Object.entries(attrs)) {
    attrStr += ` ${key}="${escapeXmlAttribute(val)}"`
  }

  return `<inline-attachment ${attrStr}>\n${cmdXml}\n${contentXml}\n` +
    `</inline-attachment>`
}

export function deserializeInlineAttachment(xml: string): InlineAttachment {
  const outer = xml.trim()
  // Extract attributes
  const openMatch = /^<inline-attachment\b([^>]*)>/.exec(outer)
  if (!openMatch) throw new Error(`Invalid inline-attachment: ${xml}`)
  const attrsStr = openMatch[1]

  // Simple attribute parser
  const attributes: Record<string, string> = {}
  const re = /([a-zA-Z0-9_:-]+)="([^"]*)"/g
  let m
  while ((m = re.exec(attrsStr)) !== null) {
    attributes[m[1]] = unescapeXmlAttribute(m[2])
  }

  const rawKind = String(attributes["kind"] || "attach")
  delete attributes["kind"]

  const kind = rawKind === "hook" ? "hook" : "attach"

  const icon =
    attributes["icon"] ?? defaultInlineAttachmentIcon(kind)
  delete attributes["icon"]

  const inner = unwrap(outer, "inline-attachment")
  const parts = extractElements(inner)

  const cmdEl = parts.find(p => /^<command\b/.test(p))
  const contentEl = parts.find(p => /^<content\b/.test(p))
  if (!cmdEl || !contentEl) {
    throw new Error(`Malformed inline-attachment inner content: ${xml}`)
  }

  const command = unescapeTags(unwrap(cmdEl, "command"))

  // Parse optional type attribute
  const contentTypeMatch = /^<content\b[^>]*\btype="([^"]*)"/.exec(contentEl)
  const mimetype = contentTypeMatch?.[1]
  const content = unescapeTags(unwrap(contentEl, "content"))

  const result: InlineAttachment = {
    kind,
    command,
    content,
    mimetype,
    icon,
  }
  if (Object.keys(attributes).length > 0) {
    result.attributes = attributes
  }
  return result
}

export function inlineNotFinal(inline : InlineAttachment) : boolean {
    return !inline.attributes || !("final" in inline.attributes)
}

export function inlineReset(inline : InlineAttachment) : boolean {
    return !!inline.attributes && ("reset" in inline.attributes)
}

export function isSerializedInlineAttachment(s: string): boolean {
  return /^<inline-attachment\b/.test(s.trim())
}
