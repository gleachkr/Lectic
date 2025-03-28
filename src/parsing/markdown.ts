import { remark } from "remark"
import remarkDirective from "remark-directive"
import type { RootContent, Parent, Link } from "mdast"
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

function extractType<T extends string>(node : RootContent, type : T) : (RootContent & { type : T })[] {
    const links : (RootContent & { type : T })[] = []
    if ("children" in node) {
        links.push(...(node.children).flatMap(c => extractType(c, type)))
    }
    if (node.type == type) {
        links.push(node as RootContent & { type : T })
    }
    return links
}

export function parseLinks(raw: string) : Link[] {
    const ast = remark().parse(raw)
    const links : Link[] = []
    for (const node of ast.children) {
        links.push(...extractType(node, "link"))
    }
    return links
}

export function parseDirectives(raw: string) : TextDirective[] {
    const ast = remark().use(remarkDirective).parse(raw)
    const directives : TextDirective[] = []
    for (const node of ast.children) {
        directives.push(...extractType(node, "textDirective"))
    }
    return directives
}

export function parseBlocks(raw: string) : RootContent[] {
    const ast = remark().use(remarkDirective).parse(raw)
    return ast.children
}
