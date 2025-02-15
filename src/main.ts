import { parseLectic } from "./parse"
import { program } from 'commander'
import { AnthropicBackend } from "./backends/anthopic"

async function main() {

  let lecticString = program.opts()["file"] == '-' 
      ? await Bun.stdin.text()
      : await Bun.file(program.opts()["file"]).text()

  const lectic = parseLectic(lecticString)

  if (lectic instanceof Error) {
      console.error(lectic.message)
      process.exit(1)
  }

  const message = await AnthropicBackend.nextMessage(lectic)


  if (!program.opts()["short"]) {
      console.log(lecticString.trim());
  }

  console.log(`
::: ${lectic.header.interlocutor.name}

  ${message.content}
  
:::`)
}

program
    .name('lectic')
    .option('-s, --short', 'only emit last message rather than updated lectic')
    .option('-f, --file <lectic>',  'lectic to read from or - to read stdin','-')

program.parse()

main()
