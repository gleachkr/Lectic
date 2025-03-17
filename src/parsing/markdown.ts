import type { RootContent, Parent, Link, Node } from "mdast"

export function nodeRaw(node : RootContent, raw : string) : string {
    const content_start = node.position?.start.offset
    const content_end = node.position?.end.offset
    return raw.slice(content_start, content_end)
}

export function nodeContentRaw(node : Parent, raw : string) : string {
    if (node.children.length > 0) {
        const content_start = node.children[0].position?.start.offset
        const content_end = node.children[node.children.length - 1].position?.start.offset

        return raw.slice(content_start, content_end)
    } else {
        return ""
    }
}

export function extractLinks(node : RootContent) : Link[] {
    const links : Link[] = []
    if ("children" in node) {
        links.push(...(node.children).flatMap(extractLinks))
    }
    if (node.type == "link") {
        links.push(node)
    }
    return links
}
