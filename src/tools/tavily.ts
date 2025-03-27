import { tavily } from "@tavily/core"
import { Tool } from "../types/tool"

export type TavilyToolSpec = {
    tavily_search: "basic" | "advanced"
    name?: string
    max_results?: number
    time_range?: "day" | "week" | "month" | "year"
    topic?: "general" | "news"
    include_raw_content?: boolean
    include_domains?: string[]
    exclude_domains?: string[]
    api_key?: string
}

export function isTavilyToolSpec(raw : unknown) : raw is TavilyToolSpec {
    return raw !== null &&
        typeof raw === "object" &&
        "tavily_search" in raw &&
        (raw.tavily_search === "basic" || raw.tavily_search === "advanced") &&
        ("name" in raw ? typeof raw.name == "string" : true) &&
        ("max_results" in raw ? 
            typeof raw.max_results === "number" &&
            Math.floor(raw.max_results) == raw.max_results &&
            raw.max_results <= 20 &&
            raw.max_results >= 0
        : true) &&
        ("time_range" in raw ? 
            typeof raw.time_range === "string" &&
            (raw.time_range === "day" || raw.time_range == "week" ||
             raw.time_range == "month" || raw.time_range == "year")
        : true) &&
        ("topic" in raw ? 
            typeof raw.topic === "string" &&
            (raw.topic === "general" || raw.topic == "news")
        : true) &&
        ("include_raw_content" in raw ? 
            typeof raw.include_raw_content === "boolean"
        : true) &&
        ("include_domains" in raw ? 
            Array.isArray(raw.include_domains) &&
            raw.include_domains.every(domain => typeof domain === "string")
        : true) &&
        ("exclude_domains" in raw ? 
            Array.isArray(raw.exclude_domains) &&
            raw.exclude_domains.every(domain => typeof domain === "string")
        : true) &&
        ("api_key" in raw ? 
            typeof raw.api_key === "string"
        : true);
}


export class TavilyTool extends Tool {

    search_depth: "basic" | "advanced"
    name: string
    max_results?: number
    time_range?: "day" | "week" | "month" | "year"
    topic?: "general" | "news"
    include_raw_content?: boolean
    include_domains?: string[]
    exclude_domains?: string[]
    api_key?: string
    description: string
    static count : number = 0

    constructor(spec: TavilyToolSpec) {
        super()
        this.search_depth = spec.tavily_search
        this.name = spec.name ?? `tavily_${TavilyTool.count}`
        this.max_results = spec.max_results
        this.time_range = spec.time_range
        this.topic = spec.topic
        // this.include_raw_content = spec.include_raw_content
        this.include_domains = spec.include_domains
        this.exclude_domains = spec.exclude_domains
        this.api_key = spec.api_key
        this.description = 
            "This tool uses a search engine to answer a question you ask, using real-time data." +
            "You should use it whenever answering a question requires access to recent information, " +
            "or when asked to search the internet." +
            "You will provide a question, like 'what is the weather in Chicago today?', and the tool will return an answer." +
            "The tool will also provide a list of search results including titles, and summarized content of the web pages used to generate the answer." +
            (this.include_raw_content 
                ? "The search results will also include the raw content of the web pages in the search results." 
                : "If there's a URL you'd like to look at more closely, ask the user for help.")

        TavilyTool.count++
        this.register()
    }

    parameters = {
        query : {
            type: "string",
            description: "a question to be answered by searching the internet, like 'what is the weather in Chicago today?'."
        }
    } as const

    required = ["query"]

    async call(args : { query : string }) : Promise<string> {
        const tvly = tavily({apiKey: process.env['TAVILY_API_KEY'] ?? this.api_key}) // TODO: make API key configurable
        const response = await tvly.search(args.query, {
            searchDepth: this.search_depth,
            topic: this.topic,
            timeRange: this.time_range,
            maxResults: this.max_results,
            includeAnswer: true,
            includeDomains: this.include_domains,
            excludeDomains: this.exclude_domains,
        }) 
        const answer = `<answer>${response.answer}</answer>`
        let results = "<results>"
        for (const result of response.results) {
            results += "<result>" +
                `<title>${result.title}</title>` +
                `<content>${result.content}<content>` +
                (result.rawContent ? `<rawContent>${result.rawContent}</rawContent>` : "") +
                `<publishedDate>${result.publishedDate}</publishedDate>` +
                `<url>${result.url}</url>` +
            "</result>"
        }
        results += `</results>`
        return answer + results
    }
}
