import { remark } from "remark"
import { visit, SKIP } from "unist-util-visit"
import remarkDirective from "remark-directive"
import type { Root, RootContent, Parent, Link, Image } from "mdast"
import type { TextDirective } from "mdast-util-directive"

export type RawRange = [number, number]

export function parseMarkdown(raw: string): Root {
    return remark().use(remarkDirective).parse(raw)
}

export function isHtmlComment(value: string): boolean {
    return /^<!--[\s\S]*?-->$/.test(value.trim())
}

export function commentRangesFromAst(ast: Root): RawRange[] {
    const ranges: RawRange[] = []

    visit(ast, "html", node => {
        if (!isHtmlComment(node.value)) return

        const start = node.position?.start.offset
        const end = node.position?.end.offset
        if (typeof start !== "number" || typeof end !== "number") return

        ranges.push([start, end])
    })

    ranges.sort((a, b) => a[0] - b[0])
    return ranges
}

export function stripRanges(
    raw: string,
    ranges: RawRange[],
    span?: { start: number, end: number }
): string {
    const start = span?.start ?? 0
    const end = span?.end ?? raw.length

    if (ranges.length === 0) return raw.slice(start, end)

    let out = ""
    let cursor = start

    for (const [rangeStart, rangeEnd] of ranges) {
        if (rangeEnd <= start) continue
        if (rangeStart >= end) break

        const clippedStart = Math.max(start, rangeStart)
        const clippedEnd = Math.min(end, rangeEnd)

        if (clippedStart > cursor) out += raw.slice(cursor, clippedStart)
        if (clippedEnd > cursor) cursor = clippedEnd
    }

    if (cursor < end) out += raw.slice(cursor, end)
    return out
}

export function stripCommentNodes(raw: string): string {
    const ast = parseMarkdown(raw)
    return stripRanges(raw, commentRangesFromAst(ast))
}

export function nodeRaw(node : RootContent, raw : string) : string {
    const content_start = node.position?.start.offset
    const content_end = node.position?.end.offset
    return raw.slice(content_start, content_end)
}

export function nodeContentRaw(node : Parent, raw : string) : string {
    if (node.children.length > 0) {
        const content_start = node.children[0].position?.start.offset
        const content_end = node.children[node.children.length - 1].position?.end.offset

        return raw.slice(content_start, content_end)
    } else {
        return ""
    }
}

// Collect link/image nodes that are in user chunks only (i.e., not inside
// any containerDirective such as interlocutor blocks).
export function parseReferences(raw: string) : (Link | Image)[] {
    return referencesFromAst(parseMarkdown(raw))
}

// Collect link/image nodes from an existing AST (user chunks only)
export function referencesFromAst(ast: Root): (Link | Image)[] {
    const out: (Link | Image)[] = []
    visit(ast, node => {
        const t = node?.type
        if (t === 'containerDirective') return SKIP
        if (t === 'link' || t === 'image') out.push(node)
    })
    return out
}

// Collect textDirective nodes in user chunks only (skip assistant blocks).
export function parseDirectives(raw: string) : TextDirective[] {
    return directivesFromAst(parseMarkdown(raw))
}

// Collect textDirective nodes from an existing AST (user chunks only)
export function directivesFromAst(ast: Root): TextDirective[] {
    const directives : TextDirective[] = []
    visit(ast, node => {
        const t = node?.type
        if (t === 'containerDirective') return SKIP
        if (t === 'textDirective') directives.push(node)
    })
    return directives
}

export function replaceDirectives(
    raw: string,
    replacer: (
        name: string,
        content: string,
        attrs?: Record<string, string | null | undefined>
    ) => string | null
) : string {
    const processor = remark().use(remarkDirective)
    const ast = processor.parse(raw)

    let changed = false
    visit(ast, "textDirective", (node, index, parent) => {
        const contentRaw = nodeContentRaw(node, raw)
        const replacement = replacer(node.name, contentRaw, node.attributes ?? undefined)
        if (replacement != null && parent && typeof index === 'number') {
            changed = true
            parent.children.splice(index, 1, {
                type: 'text',
                value: replacement
            })
        }
    })

    if (!changed) return raw

    let out = processor.stringify(ast)
    // Remark appends a single final newline by default. However, if the
    // original raw input already ended with a newline, we want to preserve
    // that exact state to maintain round‑trip equality. So we only drop a
    // single trailing newline when the input did not end with one.
    // If remark ever changes its behavior, tests should catch it; in the
    // worst case we can fall back to a simpler trim.
    const inputHasFinalNL = /\r?\n$/.test(raw)
    if (!inputHasFinalNL) out = out.replace(/\r?\n$/, "")
    return out
}

export function parseBlocks(raw: string) : RootContent[] {
    return parseMarkdown(raw).children
}
