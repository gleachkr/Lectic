import type { MessageDirective } from "./message"
import { $ } from "bun"

export class MessageCommand {
    stdout: string | undefined
    stderr: string | undefined
    success: boolean | undefined
    variant : string
    command : string

    constructor(directive : MessageDirective) {
        this.variant = directive.name
        this.command = directive.text
    }

    async execute() {
        switch (this.variant) {
            case "cmd" : {
                const rawCmd = { raw : this.command.trim() }
                const result = await $`${rawCmd}`.nothrow().quiet()
                this.stdout = result.stdout.toString()
                this.stderr = result.stderr.toString()
                this.success = result.exitCode == 0
                break
            }
            default:
        }
    }
}
