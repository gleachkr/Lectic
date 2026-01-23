import * as YAML from "yaml"
import * as fs from 'fs';
import type { Writable } from "node:stream"

function formattedMsg(context: string, logged : unknown) : string  {
    const now = new Date();
    const formattedDate = now.toLocaleString('en-US', {
        year: 'numeric',
        month: 'long',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: true,
    });
    return `
=== ${context} - ${formattedDate} ===
---
${YAML.stringify(logged, null, { blockQuote: "literal" })}
...
`
}

export const Logger : {
    logfile : null | string,
    debug(context : string, logged: unknown) : void,
    outfile: Writable
    write(output : string | AsyncIterable<string>) : Promise<void>
    fromStream(generator : AsyncIterable<string>) 
        : { chunks : AsyncIterable<string>, readonly string : string }
} = {

    logfile: null,

    outfile: process.stdout,

    debug(context, logged) {
        if (!this.logfile) return
        const fd = fs.openSync(this.logfile, 'a')

        fs.appendFileSync(fd, formattedMsg(context, logged))
        fs.closeSync(fd)
    },

    async write(output) {
        const outfile = this.outfile
        if (typeof output === "string") {
            await new Promise<void>((resolve, reject) => {
                outfile.write(output, (err?: Error | null) => err ? reject(err) : resolve())
            })
        } else {
            for await (const chunk of output) {
                await new Promise<void>((resolve, reject) => {
                    outfile.write(chunk, (err?: Error | null) => err ? reject(err) : resolve())
                })
            }
        }
    },

    fromStream(generator : AsyncIterable<string>) {
        let theString = ""
        const chunks = async function*() {
            for await (const chunk of generator) {
                theString += chunk
                yield chunk
            }
        }

        return {
            chunks: chunks(),
            get string() { return theString },
        }
    }
}
