import { describe, it, expect, beforeEach, afterAll } from 'bun:test'
import { parseCmd } from './parseCmd'
import { Logger } from './logging/logger'
import * as YAML from 'yaml'
import { writeFileSync, unlinkSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

// Mock Logger
const originalWrite = Logger.write
let logs: string[] = []
Logger.write = async (msg: string | any) => {
    logs.push(typeof msg === 'string' ? msg : JSON.stringify(msg))
}

const tempDir = tmpdir()
const testFile = join(tempDir, 'test_parse.lec')

describe('parseCmd', () => {
    
    beforeEach(() => {
        logs = []
    })

    afterAll(() => {
        Logger.write = originalWrite
        try { unlinkSync(testFile) } catch {}
    })

    it('should parse a simple lectic file to JSON', async () => {
        const content = `---
interlocutor:
  name: Bot
  provider: ollama
  model: mock-1
  prompt: You are a bot
---
Hello world
:::Bot
Hi there
:::
`
        writeFileSync(testFile, content)

        await parseCmd({ file: testFile })

        expect(logs.length).toBeGreaterThan(0)
        const output = JSON.parse(logs.join(''))
        
        expect(output.header).toBeDefined()
        expect(output.header.interlocutor.name).toBe("Bot")
        
        expect(output.messages).toHaveLength(2)
        expect(output.messages[0].role).toBe("user")
        expect(output.messages[0].content[0].type).toBe("paragraph")
        expect(output.messages[0].content[0].children[0].value).toBe("Hello world")
        
        expect(output.messages[1].role).toBe("assistant")
        expect(output.messages[1].name).toBe("Bot")
        expect(output.messages[1].content[0].type).toBe("paragraph")
        expect(output.messages[1].content[0].children[0].value).toBe("Hi there")
    })

    it('should parse a lectic file with tool calls', async () => {
        const content = `---
interlocutor:
  name: Bot
  provider: ollama
  model: mock-1
  prompt: You are a bot
---
Use a tool
:::Bot
I will use a tool.

<tool-call with="test_tool">
<arguments>
<arg>val</arg>
</arguments>
<results>
</results>
</tool-call>
:::
`
        writeFileSync(testFile, content)

        await parseCmd({ file: testFile })

        const output = JSON.parse(logs.join(''))
        const asstMsg = output.messages[1]
        
        expect(asstMsg.role).toBe("assistant")
        expect(asstMsg.content.some((n: any) => n.type === 'tool-call')).toBe(true)
        const toolCall = asstMsg.content.find((n: any) => n.type === 'tool-call')
        expect(toolCall.value).toContain('with="test_tool"')
    })

    it('should reverse parse JSON to lectic', async () => {
        const jsonInput = {
            header: {
                interlocutor: {
                    name: "ReverseBot",
                    provider: "ollama",
                    model: "mock-1",
                    prompt: "You are a bot"
                }
            },
            messages: [
                {
                    role: "user",
                    content: [
                        { type: "paragraph", children: [{ type: "text", value: "Hello reverse" }] }
                    ]
                },
                {
                    role: "assistant",
                    name: "ReverseBot",
                    content: [
                         { type: "paragraph", children: [{ type: "text", value: "Response" }] },
                         { type: "tool-call", value: '<tool-call with="tool"></tool-call>' }
                    ]
                }
            ]
        }
        
        writeFileSync(testFile, JSON.stringify(jsonInput))
        
        await parseCmd({ file: testFile, reverse: true })
        
        const output = logs.join('')
        expect(output).toContain('interlocutor:')
        expect(output).toContain('name: ReverseBot')
        expect(output).toContain('Hello reverse')
        expect(output).toContain(':::ReverseBot')
        expect(output).toContain('Response')
        expect(output).toContain('<tool-call with="tool"></tool-call>')
    })

    it('should emit YAML output when --yaml flag is used', async () => {
        const content = `---
interlocutor:
  name: Bot
  provider: ollama
  model: mock-1
  prompt: You are a bot
---
Hello
`
        writeFileSync(testFile, content)

        await parseCmd({ file: testFile, yaml: true })

        expect(logs.length).toBeGreaterThan(0)
        const output = YAML.parse(logs.join(''))
        
        expect(output.header).toBeDefined()
        expect(output.messages[0].role).toBe("user")
        expect(output.messages[0].content[0].children[0].value).toBe("Hello")
    })

    it('should parse inline attachments and mixed content', async () => {
        const content = `---
interlocutor:
  name: Bot
  provider: ollama
  model: mock-1
  prompt: You are a bot
---
User message
:::Bot
Start text.

<inline-attachment kind="cmd">
<command>echo hi</command>
<content type="text/plain">hi</content>
</inline-attachment>

Middle text.

<tool-call with="test_tool">
<arguments></arguments>
<results></results>
</tool-call>

End text.
:::
`
        writeFileSync(testFile, content)

        await parseCmd({ file: testFile })

        const output = JSON.parse(logs.join(''))
        const asstMsg = output.messages[1]
        
        expect(asstMsg.role).toBe("assistant")
        expect(asstMsg.content).toHaveLength(5)
        expect(asstMsg.content[0].type).toBe("paragraph")
        expect(asstMsg.content[1].type).toBe("inline-attachment")
        expect(asstMsg.content[2].type).toBe("paragraph")
        expect(asstMsg.content[3].type).toBe("tool-call")
        expect(asstMsg.content[4].type).toBe("paragraph")
    })

    it('should reverse parse from YAML input', async () => {
         const yamlInput = `
header:
  interlocutor:
    name: YamlBot
    provider: ollama
    model: mock-1
    prompt: You are a bot
messages:
  - role: user
    content:
      - type: paragraph
        children:
          - type: text
            value: Hello YAML
`
        writeFileSync(testFile, yamlInput)
        
        await parseCmd({ file: testFile, reverse: true })
        
        const output = logs.join('')
        expect(output).toContain('interlocutor:')
        expect(output).toContain('name: YamlBot')
        expect(output).toContain('Hello YAML')
    })
    
    it('should throw error on invalid input for reverse', async () => {
        writeFileSync(testFile, "INVALID YAML : : :")
        // We expect parseCmd to throw
        let error
        try {
            await parseCmd({ file: testFile, reverse: true })
        } catch (e) {
            error = e
        }
        expect(error).toBeDefined()
    })

    it('should parse multiple turns', async () => {
        const content = `---
interlocutor:
  name: Bot
  provider: ollama
  model: mock-1
  prompt: You are a bot
---
Turn 1
:::Bot
Response 1
:::
Turn 2
:::Bot
Response 2
:::
`
        writeFileSync(testFile, content)
        
        await parseCmd({ file: testFile })
        
        const output = JSON.parse(logs.join(''))
        expect(output.messages).toHaveLength(4)
        expect(output.messages[0].role).toBe("user")
        expect(output.messages[1].role).toBe("assistant")
        expect(output.messages[2].role).toBe("user")
        expect(output.messages[3].role).toBe("assistant")
    })
})
