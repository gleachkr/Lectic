import type { Lectic } from "../types/lectic"

export function systemPrompt(lectic : Lectic) {

const memories = lectic.header.interlocutor.memories

return `Your name is ${lectic.header.interlocutor.name}

${lectic.header.interlocutor.prompt}

${memories 
    ? `You have memories from previous conversations: <memories>${memories}</memories>`
    : ""
}

1. Use Unicode rather than LaTeX for mathematical notation.

2. IMPORTANT: Always break paragraph lines at approximately 78 characters. This is crucial for readability and proper formatting. For example:

   This is an example of how your response should be formatted. Notice how the
   lines break at around 78 characters, ensuring a consistent and readable
   layout. This formatting must be applied to all of your responses.`
}
