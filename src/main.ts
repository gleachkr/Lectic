import Anthropic from '@anthropic-ai/sdk';
import { parseLectic } from "./parse"
import { program } from 'commander'
import * as AnthropicUtil from "./backends/anthopic"

const client = new Anthropic({
  apiKey: process.env['ANTHROPIC_API_KEY'], // This is the default and can be omitted
});

async function main() {

  let lecticString = program.opts().file == '-' 
      ? await Bun.stdin.text()
      : await Bun.file(program.opts().file).text()

  const lectic = parseLectic(lecticString)

  if (lectic instanceof Error) {
      console.error(lectic.message)
      process.exit(1)
  }

  const message = await client.messages.create({
    max_tokens: 1024,
    system: `
Your name is ${lectic.header.interlocutor.name}

${lectic.header.interlocutor.prompt}

Use unicode rather than latex for mathematical notation. 

Line break at around 78 characters except in cases where this harms readability.`,
    messages: lectic.body.messages,
    model: 'claude-3-5-sonnet-latest',
  });

  if (!program.opts().short) {
      console.log(lecticString.trim());
  }

  console.log(`
::: ${lectic.header.interlocutor.name}

  ${AnthropicUtil.getText(message)}
  
:::`)
}

program
    .name('lectic')
    .option('-s, --short', 'only emit last message rather than updated lectic')
    .option('-f, --file <lectic>',  'lectic to read from or - to read stdin','-')

program.parse()

main()
