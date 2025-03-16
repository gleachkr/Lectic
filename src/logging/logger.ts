import * as YAML from "yaml"
import * as fs from 'fs';

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
    stdout(output : string | AsyncIterable<string>) : void
} = {

    logfile: null,

    debug(context, logged) {
        if (!this.logfile) return
        const fd = fs.openSync(this.logfile, 'a')

        fs.appendFileSync(fd, formattedMsg(context, logged))
        fs.closeSync(fd)
    },

    async stdout(output) {
        if (typeof output == "string") {
            console.log(output)
            return
        }

        for await (const chunk of output) {
            console.log(chunk)
        }
    }
}
