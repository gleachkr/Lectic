import { ToolCallResults, Tool, type ToolCallResult } from "../types/tool"
import open from "open"

export type ServeToolSpec = {
    serve_on_port: number
    name?: string
    usage?: string
}

export function isServeToolSpec(raw : unknown) : raw is ServeToolSpec {
    return raw !== null 
        && typeof raw === "object" 
        && "serve_on_port" in raw
        && typeof raw.serve_on_port === "number"
}

export class ServeTool extends Tool {

    name: string
    description: string
    serve_on_port: number
    static count : number = 0

    constructor(spec: ServeToolSpec) {
        super()
        this.name = spec.name ?? `serve_tool_${ServeTool.count}`
        this.serve_on_port = spec.serve_on_port
        this.description = 
            `This tool can be used to serve a web page. ` +
            `You need to supply the complete HTML (which can include <style> and <script> tags) of the web page to the tool. ` +
            `The result will be made available to the user at localhost:${spec.serve_on_port}. `


        ServeTool.count++
    }

    parameters = {
        pageHtml: {
            type : "string",
            description : "the complete HTML of the page that you wish to present to the user",
            contentMediaType: "text/html",
        }
    } as const

    required = ["pageHtml"]

    async call({ pageHtml }: { pageHtml : string }) : Promise<ToolCallResult[]> {
        this.validateArguments({ pageHtml });
        const rewriter = new HTMLRewriter()
        // ↓ NOOP atm, but leaving it because it seems like it'll be useful later
        const page = rewriter.transform(pageHtml)
        let unblock: () => void = () => {}
        const blocker = new Promise<void>(resolve => { unblock = resolve })
        const server = Bun.serve({
            port: this.serve_on_port,
            routes: {
                "/": {
                    GET: () => {
                        server.stop()
                        unblock()
                        return new Response(page, {
                            headers: {
                                "Content-Type": "text/html"
                            }
                        })
                    }
                }

            },
            fetch(_req) {
                return new Response("Not Found", { status: 404 })
            }
        })
        open(`localhost:${this.serve_on_port}`)
        await blocker
        return ToolCallResults("page is now available")
    }
}
