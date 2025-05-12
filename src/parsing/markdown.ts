import { remark } from "remark"
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

export function parseReferences(raw: string) : (Link | Image)[] {
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
    const mergedChildren : RootContent[] = []
    let inCall = false

    // We do a pass to merge each tool call into a single HTML block
    for (const block of ast.children) {
        const block_raw = nodeRaw(block, raw)
        const working_block = mergedChildren[mergedChildren.length - 1]
        if (inCall) {
            if (!(working_block && working_block.type == "html")) {
                throw new Error("Parse error, working block is not html")
            }
            working_block.value += block_raw
            if (block.position && working_block.position) {
                working_block.position.end.offset = block.position.end.offset
            }
        } else {
            mergedChildren.push(block)
            // note: the html requirement here means that the intitial tool-call
            // tag does need to all fit in one block. So it can contain
            // whitespace and up to one newline: https://spec.commonmark.org/0.31.2/#open-tag
            // That *might* be too restrictive, watch out in the future.
            if (block.type == "html" && block_raw.trim().slice(0,10) === "<tool-call") inCall = true
        }
        if (block_raw.trim().slice(-12) === "</tool-call>") inCall = false
    }

    return mergedChildren
}
