import {unwrap, extractElements } from "../parsing/xml.ts"

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
    properties: { [key : string] : JSONSchema }
}

export type JSONSchema = StringSchema 
                | NumberSchema 
                | IntegerSchema 
                | BooleanSchema 
                | ArraySchema
                | ObjectSchema

function escapeTags(string) {
    return string
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;")
    .replace(/`/g, "&#96;");
}

function unescapeTags(string) {
    return string
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#039;/g, "'")
    .replace(/&#96;/g, "`")
    .replace(/&amp;/g, "&");
}

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
                        if (!(key in arg)) {
                            if (schema.required && key in schema.required) {
                                throw new Error(`Missing property: ${key}`);
                            } else {
                                return ""
                            }
                        }
                        return `<${key}>${serialize(arg[key], properties[key])}</${key}>`;
                    }).join('')}</object>`;

        default:
            throw new Error("Unknown schema type");
    }
}



export function deserialize(xml: string, schema: JSONSchema): any {
    xml = xml.trim();
    switch (schema.type) {
        case "string":
            if (schema.enum && !schema.enum.includes(xml)) {
                throw new Error("Invalid serialized string");
            }
            return unescapeTags(xml);

        case "boolean":
            if (xml === "true") return true;
            if (xml === "false") return false;
            throw new Error("Invalid serialized boolean");

        case "number": {
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
            if (schema.required) {
                for (const key in schema.required) {
                    if (!(key in obj)) {
                        throw new Error(`Missing required property: ${key}`)
                    }
                }
            }
            return obj;
        }

        default: throw new Error("Unknown schema type");
    }
}
