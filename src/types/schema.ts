import {unwrap, extractElements, escapeTags, unescapeTags } from "../parsing/xml.ts"

type StringSchema = {
    type: "string",
    description: string
    enum? : string[]
    contentMediaType?: string
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

type NullSchema = {
    type: "null"
}

export type ObjectSchema = {
    type: "object",
    description: string
    required?: string[]
    properties: Record<string, JSONSchema>
}

type AnyOfSchema = {
    anyOf: JSONSchema[]
    description?: string
}

export type JSONSchema = StringSchema 
                | NumberSchema 
                | IntegerSchema 
                | BooleanSchema 
                | ArraySchema
                | ObjectSchema
                | NullSchema
                | AnyOfSchema

function isAnyOf(schema: JSONSchema): schema is AnyOfSchema {
    return "anyOf" in schema && schema.anyOf !== undefined
}

export function serialize(arg: unknown, schema: JSONSchema): string {
    if (isAnyOf(schema)) {
        // Try options in order; pick the first that validates
        const errors: string[] = []
        for (const option of schema.anyOf) {
            try {
                validateAgainstSchema(arg, option)
                return serialize(arg, option)
            } catch (e) {
                errors.push((e as Error)?.message ?? String(e))
            }
        }
        throw new Error(`Value does not match anyOf. Reasons: ${errors.join("; ")}`)
    }

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

        case "null":
            if (arg !== null) {
                throw new Error(`Invalid null value: ${arg}`);
            }
            return "";

        case "number":
            if (typeof arg !== "number" || 
                (schema.enum && !schema.enum.includes(arg)) || 
                (schema.minimum !== undefined && arg < schema.minimum) || 
                (schema.maximum !== undefined && arg > schema.maximum)) {
                throw new Error(`Invalid number value: ${arg}`);
            }
            return arg.toString();

        case "integer":
            if (!(typeof arg === "number" && Number.isInteger(arg)) || 
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
            // If items is a string schema with a contentMediaType, surface it
            // on the <item> tag so editor tooling can pick it up from the
            // serialized tool-call.
            const itemAttr = "type" in schema.items && schema.items.type === "string" && schema.items.contentMediaType
                ? ` contentMediaType="${schema.items.contentMediaType}"`
                : ""
            return `<array>${arg.map(item => `<item${itemAttr}>${serialize(item, schema.items)}</item>`).join('')}</array>`;

        case "object":
            if (typeof arg !== "object" || arg === null || Array.isArray(arg)) {
                throw new Error(`Invalid object value: ${arg}`);
            }
            const properties = schema.properties;
            return `<object>${Object.keys(properties)
                    .map(key => {
                        if (!(key in arg)) return ""
                        const keySchema = properties[key]
                        const attr = "type" in keySchema && keySchema.type === "string" && keySchema.contentMediaType
                            ? ` contentMediaType="${keySchema.contentMediaType}"`
                            : ""
                        return `<${key}${attr}>${serialize((arg as { [key] : unknown })[key], properties[key])}</${key}>`;
                    }).join('')}</object>`;

        default: throw new Error("type" in schema ? `Unknown schema type: ${schema["type"]}`: "Couldn't read Schema: no type");
    }
}

export function validateAgainstSchema(arg: unknown , schema: JSONSchema) : boolean {
    if (isAnyOf(schema)) {
        const errors: string[] = []
        for (const option of schema.anyOf) {
            try {
                return validateAgainstSchema(arg, option)
            } catch (e) {
                errors.push((e as Error)?.message ?? String(e))
            }
        }
        throw new Error(`Value does not match anyOf. Reasons: ${errors.join("; ")}`)
    }

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

        case "null":
            if (arg !== null) {
                throw new Error(`Invalid null value: ${arg}`);
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
            if (!(typeof arg === "number" && Number.isInteger(arg)) || 
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
            if (typeof arg !== "object" || arg === null || Array.isArray(arg)) {
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
                        return validateAgainstSchema((arg as { [key] : unknown })[key], properties[key]);
                    });
        default:
            throw new Error("Unknown schema type");
    }
}


export function deserialize(xml: string, schema: JSONSchema): any {
    if (isAnyOf(schema)) {
        const looksEscapedString = (s: string) => s.includes('\n┆') || (s.startsWith('\n') && s.endsWith('\n'))
        const order = (s: JSONSchema): number => {
            if (isAnyOf(s)) return 100
            if (!('type' in s)) return 100
            switch (s.type) {
                case 'object': return 1
                case 'array': return 2
                case 'integer': return 3
                case 'number': return 4
                case 'boolean': return 5
                case 'string': return looksEscapedString(xml) ? 6 : 99
                case 'null': return 7
                default: return 100
            }
        }
        const options = [...schema.anyOf].sort((a,b) => order(a) - order(b))
        const errors: string[] = []
        for (const option of options) {
            try {
                return deserialize(xml, option)
            } catch (e) {
                errors.push((e as Error)?.message ?? String(e))
            }
        }
        throw new Error(`Serialized value does not match anyOf. Reasons: ${errors.join("; ")}`)
    }

    switch (schema.type) {
        case "string": {
            // Don't trim: preserve exact whitespace for strings.
            const looksEscaped = xml.includes('\n┆') || (xml.startsWith('\n') && xml.endsWith('\n'))
            if (!looksEscaped) throw new Error("Invalid serialized string")
            const unescaped = unescapeTags(xml)
            if (schema.enum && !schema.enum.includes(unescaped)) {
                throw new Error("Invalid serialized string");
            }
            return unescaped;
        }

        case "null":
            xml = xml.trim();
            if (xml === "") return null;
            throw new Error("Invalid serialized null");

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
                // Extract only the tag name, ignoring any attributes.
                const keyNameRegex = /^<([a-zA-Z][a-zA-Z0-9_]*)\b/;
                const keyMatch = keyNameRegex.exec(element)
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

        default: throw new Error("type" in schema ? `Unknown schema type: ${schema["type"]}`: "Couldn't read Schema: no type");
    }
}
