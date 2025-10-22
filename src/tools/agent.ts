import { ToolCallResults, Tool, type ToolCallResult } from "../types/tool"
import { getBackend } from "../backends/util"
import { Logger } from "../logging/logger"
// XXX Circular import, would be good to fix eventually.
import { LecticHeader, Lectic } from "../types/lectic"
import { UserMessage, AssistantMessage } from "../types/message"
import type { Interlocutor } from "../types/interlocutor"

export type AgentToolSpec = {
    agent: string
    name?: string
    usage?: string
    raw_output?: boolean
}

export function isAgentToolSpec(raw : unknown) : raw is AgentToolSpec {
    return raw !== null && typeof raw === "object" && "agent" in raw
}

export class AgentTool extends Tool {

    name: string
    agent: Interlocutor
    description: string
    raw_output: boolean
    static count : number = 0

    constructor(spec: AgentToolSpec, interlocutors: Interlocutor[] ) {
        super()
        this.name = spec.name ?? `agent_tool_${AgentTool.count}`
        const agent = interlocutors.find(i => i.name === spec.agent)
        if (agent === undefined) throw Error(`There's no interlocutor named ${spec.agent}`)
        this.agent = agent
        this.raw_output = spec.raw_output ?? false
        this.description = 
            `Use the tool to send a request to the LLM ${spec.agent}. ` +
            `Each interaction is distinct, and the LLM retains no memory of your previous interactions, ` +
            `so you need to provide all information necessary for the response with each request.` + 
            `${spec.usage ? `Additional information about this LLM: ${spec.usage}` : ""}`

        AgentTool.count++
    }

    parameters = {
        content: {
            type : "string",
            description : `A request for the LLM. ` +
                `You should provide a simple question or directive. ` +
                `the LLM will do its best to reply, returning a respose as a string`,
        }
    } as const

    required = ["content"]

    async call({ content }: { content: string }) : Promise<ToolCallResult[]> {
        this.validateArguments({ content });
        const lectic = new Lectic({
            // the agent we pass in is already initialized, so there's no need
            // to initialize the header, or pass in other interlocutors for
            // recursive agent calls.
            header: new LecticHeader({interlocutor: this.agent}),
            body: { messages: [new UserMessage({ content })] },
        })
        const backend = getBackend(this.agent)
        const result = Logger.fromStream(backend.evaluate(lectic))
        for await (const _ of result.chunks) { }
        if (this.raw_output) {
            return ToolCallResults(await result.string)
        } else {
            const assistantMessage = new AssistantMessage({
                content: await result.string,
                interlocutor: this.agent
            })
            const interactions = assistantMessage.parseAssistantContent().interactions
            const sanitizedText = interactions.map((interaction) => {
                const callstring = interaction.calls
                    .map((call) => `<toolcall name=${call.name}/>`)
                    .join("\n\n")
                return `${interaction.text}\n\n${callstring}`
            }).join('\n')
            return ToolCallResults(sanitizedText)
        }
    }
}
