import { remark } from "remark"
import { visit } from "unist-util-visit"
import remarkDirective from "remark-directive"
import type { RootContent, Parent, Link, Image } from "mdast"
import type { TextDirective } from "mdast-util-directive"

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

function extractType<T extends string>(
    node : RootContent,
    type : T
) : (RootContent & { type : T })[] {
    const matches : (RootContent & { type : T })[] = []
    if ("children" in node) {
        matches.push(...(node.children).flatMap(c => extractType(c, type)))
    }
    if (node.type == type) {
        matches.push(node as RootContent & { type : T })
    }
    return matches
}

export function parseReferences(raw: string) : (Link | Image)[] {
    const ast = remark().parse(raw)
    const links : Link[] = []
    const images : Image[] = []
    for (const node of ast.children) {
        links.push(...extractType(node, "link"))
        images.push(...extractType(node, "image"))
    }
    return [...links, ...images]
}

export function parseDirectives(raw: string) : TextDirective[] {
    const ast = remark().use(remarkDirective).parse(raw)
    const directives : TextDirective[] = []
    for (const node of ast.children) {
        directives.push(...extractType(node, "textDirective"))
    }
    return directives
}

export function replaceDirectives(
    raw: string,
    replacer: (name: string, content: string) => string | null
) : string {
    const processor = remark().use(remarkDirective)
    const ast = processor.parse(raw)

    let changed = false
    visit(ast, "textDirective", (node: any, index, parent) => {
        const contentRaw = nodeContentRaw(node, raw)
        const replacement = replacer(node.name, contentRaw)
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
    return remark().use(remarkDirective).parse(raw).children
}
