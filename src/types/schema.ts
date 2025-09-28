import {unwrap, extractElements, escapeTags, unescapeTags } from "../parsing/xml.ts"

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
    required?: string[]
    properties: Record<string, JSONSchema>
}

export type JSONSchema = StringSchema 
                | NumberSchema 
                | IntegerSchema 
                | BooleanSchema 
                | ArraySchema
                | ObjectSchema

export function serialize(arg: any, schema: JSONSchema): string {
    switch (schema.type) {
        case "string":
            if (typeof arg !== "string" || (schema.enum && !schema.enum.includes(arg))) {
                throw new Error(`Invalid string value: ${arg}`);
            }
            return escapeTags(arg);

        case "boolean":
            if (typeof arg !== "boolean") {
                throw new Error(`Invalid boolean value: ${arg}`);
            }
            return arg.toString();

        case "number":
            if (typeof arg !== "number" || 
                (schema.enum && !schema.enum.includes(arg)) || 
                (schema.minimum !== undefined && arg < schema.minimum) || 
                (schema.maximum !== undefined && arg > schema.maximum)) {
                throw new Error(`Invalid number value: ${arg}`);
            }
            return arg.toString();

        case "integer":
            if (!Number.isInteger(arg) || 
                (schema.enum && !schema.enum.includes(arg)) || 
                (schema.minimum !== undefined && arg < schema.minimum) || 
                (schema.maximum !== undefined && arg > schema.maximum)) {
                throw new Error(`Invalid integer value: ${arg}`);
            }
            return arg.toString();

        case "array":
            if (!Array.isArray(arg)) {
                throw new Error(`Invalid array value: ${arg}`);
            }
            return `<array>${arg.map(item => `<item>${serialize(item, schema.items)}</item>`).join('')}</array>`;

        case "object":
            if (typeof arg !== "object" || Array.isArray(arg)) {
                throw new Error(`Invalid object value: ${arg}`);
            }
            const properties = schema.properties;
            return `<object>${Object.keys(properties)
                    .map(key => {
                        if (!(key in arg)) return ""
                        return `<${key}>${serialize(arg[key], properties[key])}</${key}>`;
                    }).join('')}</object>`;

        default:
            throw new Error("Unknown schema type");
    }
}

export function validateAgainstSchema(arg: any, schema: JSONSchema) : boolean {
    switch (schema.type) {
        case "string":
            if (typeof arg !== "string" || (schema.enum && !schema.enum.includes(arg))) {
                throw new Error(`Invalid string value: ${arg}`);
            }
            return true;

        case "boolean":
            if (typeof arg !== "boolean") {
                throw new Error(`Invalid boolean value: ${arg}`);
            }
            return true;

        case "number":
            if (typeof arg !== "number" || 
                (schema.enum && !schema.enum.includes(arg)) || 
                (schema.minimum !== undefined && arg < schema.minimum) || 
                (schema.maximum !== undefined && arg > schema.maximum)) {
                throw new Error(`Invalid number value: ${arg}`);
            }
            return true;

        case "integer":
            if (!Number.isInteger(arg) || 
                (schema.enum && !schema.enum.includes(arg)) || 
                (schema.minimum !== undefined && arg < schema.minimum) || 
                (schema.maximum !== undefined && arg > schema.maximum)) {
                throw new Error(`Invalid integer value: ${arg}`);
            }
            return true;

        case "array":
            if (!Array.isArray(arg)) {
                throw new Error(`Invalid array value: ${arg}`);
            }
            return arg.every(item => validateAgainstSchema(item, schema.items));

        case "object":
            if (typeof arg !== "object" || Array.isArray(arg)) {
                throw new Error(`Invalid object value: ${arg}`);
            }
            const properties = schema.properties;
            const required = schema.required || [];
            for (const key of required) {
                if (!(key in arg)) {
                    throw new Error(`Missing required property: ${key}`);
                }
            }
            return Object.keys(arg).every(key => {
                        if (!(key in properties)) return true
                        return validateAgainstSchema(arg[key], properties[key]);
                    });
        default:
            throw new Error("Unknown schema type");
    }
}


export function deserialize(xml: string, schema: JSONSchema): any {
    switch (schema.type) {
        case "string": {
            // Don't trim: preserve exact whitespace for strings.
            const unescaped = unescapeTags(xml)
            if (schema.enum && !schema.enum.includes(unescaped)) {
                throw new Error("Invalid serialized string");
            }
            return unescaped;
        }

        case "boolean":
            xml = xml.trim();
            if (xml === "true") return true;
            if (xml === "false") return false;
            throw new Error("Invalid serialized boolean");

        case "number": {
            xml = xml.trim();
            const num = Number(xml);
            if (isNaN(num) 
                || (schema.minimum !== undefined && num < schema.minimum) 
                || (schema.maximum !== undefined && num > schema.maximum)
                || (schema.enum && !schema.enum.includes(num))) {
                throw new Error("Invalid serialized number");
            }
            return num;
        }

        case "integer": {
            xml = xml.trim();
            const num = Number(xml);
            if (isNaN(num) 
                || !Number.isInteger(num) 
                || (schema.minimum !== undefined && num < schema.minimum) 
                || (schema.maximum !== undefined && num > schema.maximum)
                || (schema.enum && !schema.enum.includes(num))) {
                throw new Error("Invalid serialized integer");
            }
            return num;
        }

        case "array": {
            const inner = unwrap(xml, "array");
            const items: any[] = [];
            let elements = extractElements(inner)
            for (const item of elements) {
                items.push(deserialize(unwrap(item, "item"), schema.items));
            }
            return items;
        }
        
        case "object": {
            const inner = unwrap(xml, "object");
            const obj: any = {};
            let elements = extractElements(inner)
            for (const element of elements) {
                const keyRegex = new RegExp(`^<(.*?)>`);
                const keyMatch = keyRegex.exec(element)
                if (keyMatch === null) {
                    //should be unreachable
                    throw new Error(`Malformed object key: "${element}" on ${xml}`);
                }
                const key = keyMatch[1]
                if (!(key in schema.properties)) {
                    throw new Error(`Unrecognized property: ${key} on ${xml}`);
                }
                if (key in obj) {
                    throw new Error(`Duplicated property: ${key} on ${xml}`);
                }
                obj[key] = deserialize(unwrap(element, key), schema.properties[key])
            }
            return obj;
        }

        default: throw new Error("Unknown schema type");
    }
}
