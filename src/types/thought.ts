import {
  extractElements,
  escapeTags,
  unescapeTags,
  escapeXmlAttribute,
  unescapeXmlAttribute,
} from "../parsing/xml"

export type ThoughtBlock = {
  provider?: string
  providerKind?: string
  /** Provider-assigned identifier for this thought block. */
  id?: string
  status?: string
  order?: number
  /** Readable summary text entries (OpenAI). */
  summary?: string[]
  /** Readable thinking/reasoning text entries. */
  content?: string[]
  /** Provider-specific opaque data, keyed by name. */
  opaque?: Record<string, string>
}

const thoughtBlockRegex =
  /^<thought-block\b([^>]*)>([\s\S]*)<\/thought-block>$/

function parseAttributes(
  attrsStr: string
): Record<string, string> {
  const attributes: Record<string, string> = {}
  const re = /([a-zA-Z0-9_:-]+)="([^"]*)"/g
  let m
  while ((m = re.exec(attrsStr)) !== null) {
    attributes[m[1]] = unescapeXmlAttribute(m[2])
  }
  return attributes
}

function serializeAttr(
  name: string,
  value: string | number | undefined
): string {
  if (value === undefined) return ""
  return ` ${name}="${escapeXmlAttribute(String(value))}"`
}

export function serializeThoughtBlock(
  thought: ThoughtBlock
): string {
  const attrs =
    serializeAttr("provider", thought.provider) +
    serializeAttr("provider-kind", thought.providerKind) +
    serializeAttr("id", thought.id) +
    serializeAttr("status", thought.status) +
    serializeAttr("order", thought.order)

  const parts: string[] = []

  for (const s of thought.summary ?? []) {
    parts.push(`<summary>${escapeTags(s)}</summary>`)
  }

  for (const c of thought.content ?? []) {
    parts.push(`<content>${escapeTags(c)}</content>`)
  }

  for (const [name, value] of Object.entries(
    thought.opaque ?? {}
  )) {
    const nameAttr = serializeAttr("name", name)
    parts.push(`<opaque${nameAttr}>${value}</opaque>`)
  }

  return (
    `<thought-block${attrs}>\n` +
    `${parts.join("\n")}\n</thought-block>`
  )
}

export function deserializeThoughtBlock(
  xml: string
): ThoughtBlock {
  const match = thoughtBlockRegex.exec(xml.trim())
  if (!match) throw new Error(`Invalid thought-block: ${xml}`)

  const attrs = parseAttributes(match[1])
  const children = extractElements(match[2])

  const summary: string[] = []
  const content: string[] = []
  const opaque: Record<string, string> = {}

  for (const child of children) {
    if (child.startsWith("<summary")) {
      const inner = child.replace(
        /^<summary[^>]*>([\s\S]*)<\/summary>$/,
        "$1"
      )
      summary.push(unescapeTags(inner))
    } else if (child.startsWith("<content")) {
      const inner = child.replace(
        /^<content[^>]*>([\s\S]*)<\/content>$/,
        "$1"
      )
      content.push(unescapeTags(inner))
    } else if (child.startsWith("<opaque")) {
      const nameMatch = /\bname="([^"]*)"/.exec(child)
      const name = nameMatch
        ? unescapeXmlAttribute(nameMatch[1])
        : ""
      const inner = child.replace(
        /^<opaque[^>]*>([\s\S]*)<\/opaque>$/,
        "$1"
      )
      opaque[name] = inner
    }
  }

  const order = Number(attrs["order"])

  return {
    provider: attrs["provider"],
    providerKind: attrs["provider-kind"],
    id: attrs["id"],
    status: attrs["status"],
    order: Number.isFinite(order) ? order : undefined,
    ...(summary.length > 0 ? { summary } : {}),
    ...(content.length > 0 ? { content } : {}),
    ...(Object.keys(opaque).length > 0 ? { opaque } : {}),
  }
}

export function isSerializedThoughtBlock(
  raw: string
): boolean {
  return thoughtBlockRegex.test(raw.trim())
}
