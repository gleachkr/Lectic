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
    log(context : string, logged: any) : void,
} = {

    logfile: null,

    log(context, logged) {
        if (!this.logfile) return
        const fd = fs.openSync(this.logfile, 'a')

        fs.appendFileSync(fd, formattedMsg(context, logged))
        fs.closeSync(fd)
    },
}
