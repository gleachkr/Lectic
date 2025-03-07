type StringSchema = {
    type: "string",
    description: string
    enum? : string[] 
}

type BooleanSchema = {
    type: "boolean",
    description: string
}

type NumberSchema = {
    type: "number",
    description: string
    enum? : any[] // undertyped for compatibility with ollama
    minimum? : number 
    maximum? : number
}

type IntegerSchema = {
    type: "integer",
    description: string
    enum? : any[] // undertyped for compatibility with ollama
    minimum? : number 
    maximum? : number
}

type ArraySchema = {
    type: "array",
    description: string
    items: JSONSchema
}

type ObjectSchema = {
    type: "object",
    description: string
    properties: { [key : string] : JSONSchema }
}

export type JSONSchema = StringSchema 
                | NumberSchema 
                | IntegerSchema 
                | BooleanSchema 
                | ArraySchema
                | ObjectSchema

export type Tool = {
    name: string
    description: string
    parameters: { [_ : string] : JSONSchema }
    required? : string[]
    call (arg : any) : Promise<string>
}
