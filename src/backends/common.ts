import type { Lectic } from "../types/lectic"

export function wrapText({text, name} : { text : string, name: string}) {
    return `<speaker name="${name}">${text}</speaker>`
}

export function systemPrompt(lectic : Lectic) {

return `Your name is ${lectic.header.interlocutor.name}

${lectic.header.interlocutor.prompt}

1. **IMPORTANT: You must write text so that each line is no longer than 78 characters.**

2. If a sentence or phrase exceeds the 78 character limit, wrap it to the next line. 

For example:

This is an example of how your response should be formatted. Notice how the 
lines break at around 78 characters, ensuring a consistent and readable layout. 
This formatting must be applied to all of your responses.

3. Use Unicode rather than LaTeX for mathematical notation.`

}
