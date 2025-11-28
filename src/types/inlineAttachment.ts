import { escapeTags, unescapeTags } from "../parsing/xml"
import { unwrap, extractElements } from "../parsing/xml"

export type InlineAttachment = {
  kind: "cmd" | "hook"
  command: string
  content: string
  mimetype?: string // defaults to text/plain
  attributes?: Record<string, string>
}

export function serializeInlineAttachment(a: InlineAttachment): string {
  const type = a.mimetype ?? "text/plain"
  const cmdXml = `<command>${escapeTags(a.command)}</command>`
  const contentXml = `<content type="${type}">${escapeTags(a.content)}</content>`
  
  let attrStr = `kind="${a.kind}"`
  if (a.attributes) {
    for (const [key, val] of Object.entries(a.attributes)) {
      // Basic attribute escaping
      const escaped = val.replace(/"/g, "&quot;")
      attrStr += ` ${key}="${escaped}"`
    }
  }
  
  return `<inline-attachment ${attrStr}>\n${cmdXml}\n${contentXml}\n</inline-attachment>`
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
    attributes[m[1]] = m[2].replace(/&quot;/g, '"')
  }

  const kind = (attributes["kind"] || "cmd") as "cmd" | "hook"
  delete attributes["kind"]

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

  const result: InlineAttachment = { kind, command, content, mimetype }
  if (Object.keys(attributes).length > 0) {
    result.attributes = attributes
  }
  return result
}


export function isSerializedInlineAttachment(s: string): boolean {
  return /^<inline-attachment\b/.test(s.trim())
}
