import * as YAML from "yaml"
import * as fs from 'fs';
import type { Writable } from "node:stream"

function formattedMsg(context: string, logged : any) : string  {
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
    debug(context : string, logged: any) : void,
    outfile: Writable
    write(output : string | AsyncIterable<string>) : Promise<void>
    fromStream<A>(generator : AsyncIterable<string | A>) : { strings : AsyncIterable<string>, rest : Promise<A[]> }
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
        if (typeof output == "string") {
            return new Promise(resolve => this.outfile.write(output, () => resolve()))
        } else {
            return new Promise(async resolve => {
                for await (const chunk of output) {
                    await new Promise(resolve => this.outfile.write(chunk, resolve))
                }
                resolve()
            })
        }
    },

    fromStream<A>(generator : AsyncIterable<string | A>) {
        let resolver : (result : A[]) => void
        let rejector : (result : any) => void
        let accumulator : A[] = []
        let rest : Promise<A[]> = new Promise((resolve, reject) => {
            resolver = resolve
            rejector = reject
        })
        let strings = async function*() {
            try {
                for await (const x of generator) {
                    if (typeof x === "string") { yield x }
                    else { accumulator.push(x) }
                }
            } catch (e) {
                rejector(e)
            } finally {
                resolver(accumulator)
            }
        }
        return { strings: strings(), rest }
    }
}
