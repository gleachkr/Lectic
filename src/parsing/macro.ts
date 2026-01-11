import { remark } from "remark"
import remarkDirective from "remark-directive"
import type { Root, RootContent, Parent, Text, PhrasingContent} from "mdast"
import type { TextDirective } from "mdast-util-directive";
import { Macro } from "../types/macro"

const processor = remark().use(remarkDirective)

function nodesToMarkdown(nodes: RootContent[]): string {
    const root: Root = { type: 'root', children: nodes }
    let out = processor.stringify(root)
    // remark.stringify adds a trailing newline if there are children.
    if (nodes.length > 0) {
        out = out.replace(/\r?\n$/, "")
    }
    return out
}

const reserved = new Set(["cmd", "ask", "aside", "reset"])

export type MacroMessageEnv = {
    MESSAGE_INDEX : number,
    MESSAGES_LENGTH : number,
}

function skipDirective(node : TextDirective, messageEnv? : MacroMessageEnv) {
    const nameLower = node.name.toLowerCase()
    // Don't expand under reserved directives
    if (reserved.has(nameLower)) return true
    // Or under :attach, unless we're processing the final message
    if (nameLower == "attach" && messageEnv &&
        messageEnv.MESSAGE_INDEX != messageEnv.MESSAGES_LENGTH) return true
}

export async function expandMacros(
    text: string,
    macros: Record<string, Macro>,
    messageEnv?: MacroMessageEnv
): Promise<string> {
    if (Object.keys(macros).length === 0) return text

    const ast = processor.parse(text)
    let changed = false

    async function walk(node: RootContent, raw: string, depth: number = 0): Promise<RootContent[]> {
        if (depth > 100) throw new Error("Macro recursion depth limit exceeded")

        if (node.type === 'containerDirective') {
            return [node]
        }

        if (node.type === 'textDirective') {
            if (skipDirective(node, messageEnv)) return [node]
            const macro = macros[node.name.toLowerCase()]
            if (macro) {
                changed = true
                const env: Record<string, string | undefined> = {
                    ...Object.fromEntries(
                        Object.entries(messageEnv ?? []).map(([k,v]) => [k,String(v)])),
                    ...node.attributes,
                    ARG: node.attributes?.['ARG'] ?? nodesToMarkdown(node.children)
                }

                const preResult = await macro.expandPre(env)
                if (preResult !== undefined) {
                    const parsed = processor.parse(preResult).children
                    const processedResult: RootContent[] = []
                    for (const n of parsed) {
                        processedResult.push(...await walk(n, preResult, depth + 1))
                    }
                    if (processedResult.length > 0) return processedResult
                    // If parsing returned no nodes (e.g. empty comment), return empty text node
                    const empty: Text = { type: 'text', value: '' }
                    return [empty]
                }

                // Pre didn't return (or returned empty), so process children
                const newChildren: RootContent[] = []
                for (const child of node.children) {
                    newChildren.push(...await walk(child, raw, depth + 1))
                }
                
                // We need to cast here, since technically an inline
                // directive's children must be phrasing content.
                node.children = newChildren as PhrasingContent[]

                // Update ARG with processed children
                env['ARG'] = node.attributes?.['ARG'] ?? nodesToMarkdown(node.children)
                
                const postResult = await macro.expandPost(env)
                if (postResult !== undefined) {
                    const parsed = processor.parse(postResult).children
                    const processedResult: RootContent[] = []
                    for (const n of parsed) {
                        processedResult.push(...await walk(n, postResult, depth + 1))
                    }
                    if (processedResult.length > 0) return processedResult
                    return [{ type: 'text', value: '' }]
                }
            }
        }

        if ('children' in node) {
            const parent = node as Parent
            const newChildren: RootContent[] = []
            for (const child of parent.children) {
                newChildren.push(...await walk(child, raw, depth))
            }
            parent.children = newChildren
        }

        return [node]
    }

    const newChildren: RootContent[] = []
    for (const child of ast.children) {
        newChildren.push(...await walk(child, text))
    }
    ast.children = newChildren

    if (!changed) return text

    let out = processor.stringify(ast)
    const inputHasFinalNL = /\r?\n$/.test(text)
    if (!inputHasFinalNL) out = out.replace(/\r?\n$/, "")
    return out
}
