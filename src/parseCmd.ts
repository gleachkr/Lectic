import { program, type OptionValues } from 'commander'
import { parseLectic, getYaml } from './parsing/parse'
import { getLecticString, getIncludes } from './utils/cli'
import { UserMessage, AssistantMessage } from './types/message'
import { isSerializedCall } from './types/tool'
import { isSerializedInlineAttachment } from './types/inlineAttachment'
import { remark } from 'remark'
import remarkDirective from 'remark-directive'
import * as YAML from 'yaml'
import type { RootContent, Root } from 'mdast'
import { Logger } from './logging/logger'
import { isObjectRecord } from './types/guards'

type ToolCallNode = {
    type: 'tool-call'
    value: string
}

type InlineAttachmentNode = {
    type: 'inline-attachment'
    value: string
}

type ParsedContentNode = RootContent | ToolCallNode | InlineAttachmentNode

type ParsedMessage = {
    role: 'user' | 'assistant'
    name?: string
    content: ParsedContentNode[]
}

type ParsedLectic = {
    header: unknown
    messages: ParsedMessage[]
}

function isToolCallNode(node: unknown ): node is ToolCallNode {
    return isObjectRecord(node) && 
        node["type"] === 'tool-call' && 
        typeof node["value"] === 'string'
}

function isInlineAttachmentNode(node: unknown): node is InlineAttachmentNode {
    return isObjectRecord(node) && 
        node["type"] === 'inline-attachment' && 
        typeof node["value"] === 'string'
}

type ParseOpts = OptionValues & { yaml?: boolean, reverse?: boolean }

type ParseCmdOpts = Partial<OptionValues> & {
    yaml?: boolean
    reverse?: boolean
}

export async function parseCmd(cmdOpts: ParseCmdOpts = {}) {
    const globalOpts = program.opts()
    // Merge options, prioritizing command options
    const opts = { ...globalOpts, ...cmdOpts } as ParseOpts

    if (opts.reverse) {
        await handleReverse(opts)
    } else {
        await handleParse(opts)
    }
}

async function handleParse(opts: ParseOpts) {
    
    const lecticString = await getLecticString(opts)
    const rawHeaderYaml = getYaml(lecticString)
    const header = rawHeaderYaml ? {raw : rawHeaderYaml, ...YAML.parse(rawHeaderYaml)} : {}
    
    // We use the standard parseLectic logic (including system configs) to get
    // the Lectic object, which ensures we have a valid header and can identify
    // interlocutors in the body. But for the output `header` field, we use the
    // raw YAML from the file.
    
    const includes = await getIncludes()
    const lectic = await parseLectic(lecticString, includes)
    
    const messages: ParsedMessage[] = []
    
    for (const msg of lectic.body.messages) {
        if (msg instanceof UserMessage) {
            const ast = remark().use(remarkDirective).parse(msg.content)
            messages.push({ role: 'user', content: ast.children })
        } else if (msg instanceof AssistantMessage) {
            const ast = remark().use(remarkDirective).parse(msg.content)
            const content: ParsedContentNode[] = []
            
            for (const node of ast.children) {
                if (node.type === 'html') {
                    if (isSerializedCall(node.value)) {
                        content.push({ type: 'tool-call', value: node.value })
                        continue
                    }
                    if (isSerializedInlineAttachment(node.value)) {
                        content.push({ type: 'inline-attachment', value: node.value })
                        continue
                    }
                }
                content.push(node)
            }
            
            messages.push({ role: 'assistant', name: msg.name, content: content })
        }
    }
    
    const output: ParsedLectic = {
        header: header,
        messages: messages
    }
    
    if (opts.yaml) {
        await Logger.write(YAML.stringify(output, null, { blockQuote: "literal" }))
    } else {
        await Logger.write(JSON.stringify(output, null, 2))
    }
}

async function handleReverse(opts: ParseOpts) {

    const inputString = await getLecticString(opts)
    
    let input: ParsedLectic
    try {
        // Parse input as YAML (superset of JSON)
        input = YAML.parse(inputString) as ParsedLectic
    } catch (e) {
        throw new Error(`Failed to parse input: ${e instanceof Error ? e.message : String(e)}`)
    }
    
    if (!input || typeof input !== 'object') {
        throw new Error("Invalid input format")
    }
    
    // Reconstruct Header
    const headerYaml = input.header && Object.keys(input.header).length > 0 
        ? YAML.stringify(input.header).trim() 
        : ""
        
    let output = ""
    if (headerYaml) {
        output += `---\n${headerYaml}\n---\n\n`
    }
    
    // Reconstruct Body
    if (Array.isArray(input.messages)) {
        for (const msg of input.messages) {
            if (msg.role === 'user') {
                const root: Root = { type: 'root', children: msg.content as RootContent[] }
                const markdown = remark().use(remarkDirective).stringify(root)
                output += `${markdown.trim()}\n\n`
            } else if (msg.role === 'assistant') {
                output += `:::${msg.name}\n\n`
                
                const children = msg.content
                let currentMarkdownNodes: RootContent[] = []
                
                const flushMarkdown = () => {
                    if (currentMarkdownNodes.length > 0) {
                        const root: Root = { type: 'root', children: currentMarkdownNodes }
                        const markdown = remark().use(remarkDirective).stringify(root)
                        output += `${markdown.trim()}\n\n`
                        currentMarkdownNodes = []
                    }
                }
                
                for (const node of children) {
                    if (isToolCallNode(node)) {
                        flushMarkdown()
                        output += `${node.value.trim()}\n\n`
                    } else if (isInlineAttachmentNode(node)) {
                        flushMarkdown()
                        output += `${node.value.trim()}\n\n`
                    } else {
                        // Cast to RootContent (mdast node)
                        currentMarkdownNodes.push(node as RootContent)
                    }
                }
                flushMarkdown()
                
                output += `:::\n\n`
            }
        }
    }
    
    // Clean up extra newlines at end
    output = output.trim() + "\n"
    
    await Logger.write(output)
}
