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
    fromStream<A>(generator : AsyncIterable<string | A>) 
        : { chunks : AsyncIterable<string>, string : Promise<string>, rest : Promise<A[]> }
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
        if (typeof output == "string") {
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

    // XXX: from stream is a bit of a legacy method here, but it lets us
    // potentially yield things other than strings during the lectic execution,
    // as `rest`, which is a nice to have, so I leave it here.
    fromStream<A>(generator : AsyncIterable<string | A>) {
        let resolver1 : (result : A[]) => void
        let rejector1 : (result : unknown) => void
        let resolver2 : (result : string) => void
        let rejector2 : (result : unknown) => void
        const accumulator : A[] = []
        let theString = ""
        const rest : Promise<A[]> = new Promise((resolve, reject) => {
            resolver1 = resolve
            rejector1 = reject
        })
        const string : Promise<string> = new Promise((resolve, reject) => {
            resolver2 = resolve
            rejector2 = reject
        })
        const chunks = async function*() {
            try {
                for await (const x of generator) {
                    if (typeof x === "string") { 
                        yield x 
                        theString += x
                    }
                    else { accumulator.push(x) }
                }
            } catch (e) {
                rejector1(e)
                rejector2(e)
            } finally {
                resolver1(accumulator)
                resolver2(theString)
            }
        }
        return { chunks: chunks(), rest, string }
    }
}
