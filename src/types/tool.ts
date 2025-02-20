type SchemaType = "object" | "number" | "string" | "integer" | "boolean" | "array" | "null"

type ToolParameter = {
    type: SchemaType,
    description: string
    enum? : any[] // An array of possible responses TODO can this be more precisely typed?
    minimum? : number // minimum or maximum for numeric types
    maximum? : number
}

// TODO can this be more precisely typed? Can I infer the argument type for the call method?
export type Tool = {
    name: string
    description: string
    parameters: {
        [_ : string] : ToolParameter
    }
    required? : string[]
    call (arg : any) : Promise<string>
}
