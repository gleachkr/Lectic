import type { MessageDirective } from "./message"
import { $ } from "bun"

export class MessageCommand {
    variant : string
    command : string

    constructor(directive : MessageDirective) {
        this.variant = directive.name
        this.command = directive.text
    }

    async execute() {
        switch (this.variant) {
            case "cmd" : {
                const rawCmd = { 
                    raw : this.command
                            .trim()
                            .replace(/[\n\r]+/g,'') 
                }
                const result = await $`${rawCmd}`.nothrow().quiet()
                if (result.exitCode === 0) {
                    return `<stdout from="${this.command}">${result.stdout.toString()}</stdout>`
                } else {
                    return `<error>Something went wrong when executing a command:` + 
                        `<stdout from="${this.command}">${result.stdout.toString()}</stdout>` +
                        `<stderr from="${this.command}">${result.stderr.toString()}</stderr>` +
                    `</error>`
                }
            }
            default: return null
        }
    }
}
