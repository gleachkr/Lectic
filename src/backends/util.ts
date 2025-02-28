import type { Lectic } from "../types/lectic"

export function systemPrompt(lectic : Lectic) {

const memories = lectic.header.interlocutor.memories

return `Your name is ${lectic.header.interlocutor.name}

${lectic.header.interlocutor.prompt}

${memories 
    ? `You have memories from previous conversations: <memories>${memories}</memories>`
    : ""
}

Use unicode rather than latex for mathematical notation. 

Line break at around 78 characters except in cases where this harms readability.`
}
