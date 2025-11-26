import { escapeTags, unescapeTags } from "../parsing/xml"
import { unwrap, extractElements } from "../parsing/xml"

export type InlineAttachment = {
  kind: "cmd" | "hook"
  command: string
  content: string
  mimetype?: string // defaults to text/plain
}

export function serializeInlineAttachment(a: InlineAttachment): string {
  const type = a.mimetype ?? "text/plain"
  const cmdXml = `<command>${escapeTags(a.command)}</command>`
  const contentXml = `<content type="${type}">${escapeTags(a.content)}</content>`
  return `<inline-attachment kind="${a.kind}">\n${cmdXml}\n${contentXml}\n</inline-attachment>`
}

export function deserializeInlineAttachment(xml: string): InlineAttachment {
  const outer = xml.trim()
  // Extract attributes
  const openMatch = /^<inline-attachment\b([^>]*)>/.exec(outer)
  if (!openMatch) throw new Error(`Invalid inline-attachment: ${xml}`)
  const attrs = openMatch[1]
  const kindMatch = /\bkind="([^"]*)"/.exec(attrs)
  const kind = (kindMatch?.[1] || "cmd") as "cmd" | "hook"

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

  return { kind, command, content, mimetype }
}


export function isSerializedInlineAttachment(s: string): boolean {
  return /<inline-attachment\b/.test(s.trim())
}
