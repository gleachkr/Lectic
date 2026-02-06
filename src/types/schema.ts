import {unwrap, extractElements, escapeTags, unescapeTags } from "../parsing/xml.ts"
import { isObjectRecord } from "./guards.ts"

type StringSchema = {
    type: "string",
    description?: string
    enum? : string[]
    contentMediaType?: string
}

function assertNoUnknownKeys(
    v: Record<string, unknown>,
    allowed: Set<string>,
    path: string,
) {
    for (const key of Object.keys(v)) {
        if (!allowed.has(key)) {
            throw new Error(`Unknown key "${key}" at ${path}`)
        }
    }
}

function schemaPath(path: (string | number)[]): string {
    if (path.length === 0) return "schema"
    return "schema." + path.join(".")
}

export function validateJSONSchema(raw: unknown): raw is JSONSchema {
    const visit = (v: unknown, path: (string | number)[]): void => {
        if (!isObjectRecord(v)) {
            throw new Error(`Expected object at ${schemaPath(path)}`)
        }

        const obj = v
        const baseAllowed = new Set(["description", "default"])

        if ("anyOf" in obj) {
            assertNoUnknownKeys(
                obj,
                new Set(["anyOf", ...baseAllowed]),
                schemaPath(path),
            )

            const anyOfVal = obj["anyOf"]
            if (!Array.isArray(anyOfVal)) {
                throw new Error(
                    `Expected array at ${schemaPath([...path, "anyOf"])}`
                )
            }
            for (let i = 0; i < anyOfVal.length; i++) {
                visit(anyOfVal[i], [...path, "anyOf", i])
            }
            return
        }

        const typeVal = obj["type"]
        if (typeof typeVal !== "string") {
            throw new Error(`Missing schema type at ${schemaPath(path)}`)
        }

        switch (typeVal) {
            case "string": {
                assertNoUnknownKeys(
                    obj,
                    new Set(["type", "enum", "contentMediaType", ...baseAllowed]),
                    schemaPath(path),
                )

                const enumVal = obj["enum"]
                if ("enum" in obj && !Array.isArray(enumVal)) {
                    throw new Error(`Expected array at ${schemaPath([...path, "enum"])}`)
                }
                if (
                    Array.isArray(enumVal) &&
                    !enumVal.every((x) => typeof x === "string")
                ) {
                    throw new Error(`Expected string[] at ${schemaPath([...path, "enum"])}`)
                }

                const cmtVal = obj["contentMediaType"]
                if ("contentMediaType" in obj && typeof cmtVal !== "string") {
                    throw new Error(
                        `Expected string at ${schemaPath([...path, "contentMediaType"])}`
                    )
                }
                break
            }

            case "boolean": {
                assertNoUnknownKeys(
                    obj,
                    new Set(["type", ...baseAllowed]),
                    schemaPath(path)
                )
                break
            }

            case "null": {
                assertNoUnknownKeys(
                    obj,
                    new Set(["type", ...baseAllowed]),
                    schemaPath(path)
                )
                break
            }

            case "number":
            case "integer": {
                assertNoUnknownKeys(
                    obj,
                    new Set(["type", "enum", "minimum", "maximum", ...baseAllowed]),
                    schemaPath(path),
                )

                const enumVal = obj["enum"]
                if ("enum" in obj && !Array.isArray(enumVal)) {
                    throw new Error(`Expected array at ${schemaPath([...path, "enum"])}`)
                }
                if (
                    Array.isArray(enumVal) &&
                    !enumVal.every((x) => typeof x === "number")
                ) {
                    throw new Error(`Expected number[] at ${schemaPath([...path, "enum"])}`)
                }

                const minVal = obj["minimum"]
                if ("minimum" in obj && typeof minVal !== "number") {
                    throw new Error(
                        `Expected number at ${schemaPath([...path, "minimum"])}`
                    )
                }

                const maxVal = obj["maximum"]
                if ("maximum" in obj && typeof maxVal !== "number") {
                    throw new Error(
                        `Expected number at ${schemaPath([...path, "maximum"])}`
                    )
                }
                break
            }

            case "array": {
                assertNoUnknownKeys(
                    obj,
                    new Set(["type", "items", ...baseAllowed]),
                    schemaPath(path)
                )

                if (!("items" in obj)) {
                    throw new Error(`Missing items at ${schemaPath([...path, "items"])}`)
                }
                visit(obj["items"], [...path, "items"])
                break
            }

            case "object": {
                assertNoUnknownKeys(
                    obj,
                    new Set([
                        "type",
                        "properties",
                        "required",
                        "additionalProperties",
                        ...baseAllowed,
                    ]),
                    schemaPath(path),
                )

                const propsVal = obj["properties"]
                if (!("properties" in obj) || !isObjectRecord(propsVal)) {
                    throw new Error(
                        `Expected object at ${schemaPath([...path, "properties"])}`
                    )
                }
                for (const [k, child] of Object.entries(propsVal)) {
                    visit(child, [...path, "properties", k])
                }

                const reqVal = obj["required"]
                if ("required" in obj) {
                    if (!Array.isArray(reqVal)) {
                        throw new Error(
                            `Expected array at ${schemaPath([...path, "required"])}`
                        )
                    }
                    if (!reqVal.every((x) => typeof x === "string")) {
                        throw new Error(
                            `Expected string[] at ${schemaPath([...path, "required"])}`
                        )
                    }
                }

                const apVal = obj["additionalProperties"]
                if ("additionalProperties" in obj && typeof apVal !== "boolean") {
                    throw new Error(
                        `Expected boolean at ${schemaPath([...path, "additionalProperties"])}`
                    )
                }
                break
            }

            default:
                throw new Error(
                    `Unknown schema type "${typeVal}" at ${schemaPath(path)}`
                )
        }

        const descVal = obj["description"]
        if ("description" in obj && typeof descVal !== "string") {
            throw new Error(
                `Expected string at ${schemaPath([...path, "description"])}`
            )
        }
    }

    visit(raw, [])
    return true
}

export function isJSONSchema(raw: unknown): raw is JSONSchema {
    try {
        return validateJSONSchema(raw)
    } catch {
        return false
    }
}

type BooleanSchema = {
    type: "boolean",
    description?: string
}

type NumberSchema = {
    type: "number",
    description?: string
    enum? : unknown[] // provider enums are sometimes untyped; validate at runtime
    minimum? : number 
    maximum? : number
}

type IntegerSchema = {
    type: "integer",
    description?: string
    enum? : unknown[] // provider enums are sometimes untyped; validate at runtime
    minimum? : number 
    maximum? : number
}

type ArraySchema = {
    type: "array",
    description?: string
    items: JSONSchema
}

type NullSchema = {
    type: "null"
}

export type ObjectSchema = {
    type: "object",
    description?: string
    required?: string[]
    properties: Record<string, JSONSchema>
    additionalProperties?: boolean
}

type AnyOfSchema = {
    anyOf: JSONSchema[]
    description?: string
}

// rewrites schema for compatibility with OAI strict mode
// https://platform.openai.com/docs/guides/structured-outputs/supported-schemas#supported-schemas
// - defaults aren't supported
// https://platform.openai.com/docs/guides/function-calling#strict-mode
// in strict mode
// - additionalProperties must be false on all objects
// - all properties of each object must be required
//
// OAI suggests emulating optional fields by making them nullable:
// anyOf: [<schema>, { type: "null" }]
export function strictify(schema : JSONSchema) : JSONSchema {
    let rslt : JSONSchema
    if (!("type" in schema)) {
        rslt = {
            ...schema,
            anyOf: schema.anyOf.map(strictify), 
        }
    } else {
        switch (schema.type) {
            case "string": 
            case "number":
            case "integer":
            case "boolean":
            case "null" : 
                rslt = schema
                break
            case "array": 
                rslt = {
                    ...schema,
                    items: strictify(schema.items)
                }
                break
            case "object": {
                const strictProps = Object.fromEntries(
                    Object.entries(schema.properties).map(([k, v]) => {
                        let prop = strictify(v)
                        if (!schema.required?.includes(k)) {
                            prop = makeNullable(prop)
                        }
                        return [k, prop]
                    })
                )

                rslt = {
                    ...schema,
                    properties: strictProps,
                    required: Object.keys(schema.properties),
                    additionalProperties: false,
                }
                break
            }
            default:
                throw Error("unrecognized schema type in strictify")
        }
    }
    if ("default" in rslt) delete rslt.default
    return rslt
}

function isNullSchema(schema: JSONSchema): boolean {
    return "type" in schema && schema.type === "null"
}

function isNullable(schema: JSONSchema): boolean {
    if (isNullSchema(schema)) return true
    if (isAnyOf(schema)) return schema.anyOf.some(isNullable)
    return false
}

function makeNullable(schema: JSONSchema): JSONSchema {
    if (isNullable(schema)) return schema

    if (isAnyOf(schema)) {
        return {
            ...schema,
            anyOf: [...schema.anyOf, { type: "null" }],
        }
    }

    const desc = "description" in schema ? schema.description : undefined
    return {
        anyOf: [schema, { type: "null" }],
        ...(desc ? { description: desc } : {}),
    }
}

function pickAnyOfOption(value: unknown, anyOf: JSONSchema[]): JSONSchema {
    if (value === null) {
        return anyOf.find(isNullSchema) ?? anyOf[0]
    }

    if (Array.isArray(value)) {
        return anyOf.find((s) => "type" in s && s.type === "array") ?? anyOf[0]
    }

    if (isObjectRecord(value)) {
        return anyOf.find((s) => "type" in s && s.type === "object") ?? anyOf[0]
    }

    switch (typeof value) {
        case "string":
            return anyOf.find((s) => "type" in s && s.type === "string")
                ?? anyOf[0]
        case "boolean":
            return anyOf.find((s) => "type" in s && s.type === "boolean")
                ?? anyOf[0]
        case "number": {
            const want = Number.isInteger(value) ? "integer" : "number"
            const exact = anyOf.find((s) => "type" in s && s.type === want)
            const fallback = anyOf.find(
                (s) => "type" in s && (s.type === "integer" || s.type === "number")
            )
            return exact ?? fallback ?? anyOf[0]
        }
        default:
            return anyOf[0]
    }
}

// Post-process a value returned by OAI strict mode.
//
// When strictifying we make optional object properties nullable, and also
// mark all object properties as required. The model may then return `null`
// for an omitted optional property. This function removes those `null`
// properties (based on the schema's `required` list) so that downstream
// tool validation sees the original shape.
export function destrictify(value: unknown, schema: JSONSchema): unknown {
    if (isAnyOf(schema)) {
        const option = pickAnyOfOption(value, schema.anyOf)
        return destrictify(value, option)
    }

    switch (schema.type) {
        case "object": {
            if (!isObjectRecord(value)) return value
            const required = new Set(schema.required ?? [])
            const out: Record<string, unknown> = {}

            for (const [k, v] of Object.entries(value)) {
                const propSchema = schema.properties[k]
                if (!propSchema) {
                    out[k] = v
                    continue
                }

                if (v === null && !required.has(k)) {
                    continue
                }

                out[k] = destrictify(v, propSchema)
            }

            return out
        }
        case "array": {
            if (!Array.isArray(value)) return value
            return value.map((v) => destrictify(v, schema.items))
        }
        default:
            return value
    }
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
        case "string": {
            if (typeof arg !== "string" || (schema.enum && !schema.enum.includes(arg))) {
                throw new Error(`Invalid string value: ${arg}`)
            }
            return escapeTags(arg)
        }

        case "boolean": {
            if (typeof arg !== "boolean") {
                throw new Error(`Invalid boolean value: ${arg}`)
            }
            return arg.toString()
        }

        case "null": {
            if (arg !== null) {
                throw new Error(`Invalid null value: ${arg}`)
            }
            return ""
        }

        case "number": {
            if (typeof arg !== "number" || 
                (schema.enum && !schema.enum.includes(arg)) || 
                (schema.minimum !== undefined && arg < schema.minimum) || 
                (schema.maximum !== undefined && arg > schema.maximum)) {
                throw new Error(`Invalid number value: ${arg}`)
            }
            return arg.toString()
        }

        case "integer": {
            if (!(typeof arg === "number" && Number.isInteger(arg)) || 
                (schema.enum && !schema.enum.includes(arg)) || 
                (schema.minimum !== undefined && arg < schema.minimum) || 
                (schema.maximum !== undefined && arg > schema.maximum)) {
                throw new Error(`Invalid integer value: ${arg}`)
            }
            return arg.toString()
        }

        case "array": {
            if (!Array.isArray(arg)) {
                throw new Error(`Invalid array value: ${arg}`)
            }
            // If items is a string schema with a contentMediaType, surface it
            // on the <item> tag so editor tooling can pick it up from the
            // serialized tool-call.
            const itemAttr = "type" in schema.items && schema.items.type === "string" && schema.items.contentMediaType
                ? ` contentMediaType="${schema.items.contentMediaType}"`
                : ""
            return `<array>${arg.map(item => `<item${itemAttr}>${serialize(item, schema.items)}</item>`).join('')}</array>`
        }

        case "object": {
            if (typeof arg !== "object" || arg === null || Array.isArray(arg)) {
                throw new Error(`Invalid object value: ${arg}`)
            }
            const properties = schema.properties
            return `<object>${Object.keys(properties)
                    .map(key => {
                        if (!(key in arg)) return ""
                        const keySchema = properties[key]
                        const attr = "type" in keySchema && keySchema.type === "string" && keySchema.contentMediaType
                            ? ` contentMediaType="${keySchema.contentMediaType}"`
                            : ""
                        return `<${key}${attr}>${serialize((arg as { [key] : unknown })[key], properties[key])}</${key}>`
                    }).join('')}</object>`

        }
        default: throw new Error("type" in schema ? `Unknown schema type: ${schema["type"]}`: "Couldn't read Schema: no type")
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
        case "string": {
            if (typeof arg !== "string" || (schema.enum && !schema.enum.includes(arg))) {
                throw new Error(`Invalid string value: ${arg}`)
            }
            return true
        }

        case "boolean": {
            if (typeof arg !== "boolean") {
                throw new Error(`Invalid boolean value: ${arg}`)
            }
            return true
        }

        case "null": {
            if (arg !== null) {
                throw new Error(`Invalid null value: ${arg}`)
            }
            return true
        }

        case "number": {
            if (typeof arg !== "number" || 
                (schema.enum && !schema.enum.includes(arg)) || 
                (schema.minimum !== undefined && arg < schema.minimum) || 
                (schema.maximum !== undefined && arg > schema.maximum)) {
                throw new Error(`Invalid number value: ${arg}`)
            }
            return true
        }

        case "integer": {
            if (!(typeof arg === "number" && Number.isInteger(arg)) || 
                (schema.enum && !schema.enum.includes(arg)) || 
                (schema.minimum !== undefined && arg < schema.minimum) || 
                (schema.maximum !== undefined && arg > schema.maximum)) {
                throw new Error(`Invalid integer value: ${arg}`)
            }
            return true
        }

        case "array": {
            if (!Array.isArray(arg)) {
                throw new Error(`Invalid array value: ${arg}`)
            }
            return arg.every(item => validateAgainstSchema(item, schema.items))
        }

        case "object": {
            if (typeof arg !== "object" || arg === null || Array.isArray(arg)) {
                throw new Error(`Invalid object value: ${arg}`)
            }
            const properties = schema.properties
            const required = schema.required || []
            for (const key of required) {
                if (!(key in arg)) {
                    throw new Error(`Missing required property: ${key}`)
                }
            }
            return Object.keys(arg).every(key => {
                        if (!(key in properties)) return true
                        return validateAgainstSchema((arg as { [key] : unknown })[key], properties[key])
                    })
        }
        default:
            throw new Error("Unknown schema type")
    }
}


export function deserialize(xml: string, schema: JSONSchema): unknown {
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
                throw new Error("Invalid serialized string")
            }
            return unescaped
        }

        case "null":
            xml = xml.trim()
            if (xml === "") return null
            throw new Error("Invalid serialized null")

        case "boolean":
            xml = xml.trim()
            if (xml === "true") return true
            if (xml === "false") return false
            throw new Error("Invalid serialized boolean")

        case "number": {
            xml = xml.trim()
            const num = Number(xml)
            if (isNaN(num) 
                || (schema.minimum !== undefined && num < schema.minimum) 
                || (schema.maximum !== undefined && num > schema.maximum)
                || (schema.enum && !schema.enum.includes(num))) {
                throw new Error("Invalid serialized number")
            }
            return num
        }

        case "integer": {
            xml = xml.trim()
            const num = Number(xml)
            if (isNaN(num) 
                || !Number.isInteger(num) 
                || (schema.minimum !== undefined && num < schema.minimum) 
                || (schema.maximum !== undefined && num > schema.maximum)
                || (schema.enum && !schema.enum.includes(num))) {
                throw new Error("Invalid serialized integer")
            }
            return num
        }

        case "array": {
            const inner = unwrap(xml, "array")
            const items: unknown[] = []
            const elements = extractElements(inner)
            for (const item of elements) {
                items.push(deserialize(unwrap(item, "item"), schema.items))
            }
            return items
        }
        
        case "object": {
            const inner = unwrap(xml, "object")
            const obj: Record<string, unknown> = {}
            const elements = extractElements(inner)
            for (const element of elements) {
                // Extract only the tag name, ignoring any attributes.
                const keyNameRegex = /^<([a-zA-Z][a-zA-Z0-9_]*)\b/
                const keyMatch = keyNameRegex.exec(element)
                if (keyMatch === null) {
                    //should be unreachable
                    throw new Error(`Malformed object key: "${element}" on ${xml}`)
                }
                const key = keyMatch[1]
                if (!(key in schema.properties)) {
                    throw new Error(`Unrecognized property: ${key} on ${xml}`)
                }
                if (key in obj) {
                    throw new Error(`Duplicated property: ${key} on ${xml}`)
                }
                obj[key] = deserialize(unwrap(element, key), schema.properties[key])
            }
            return obj
        }

        default: {
            throw new Error("type" in schema ? `Unknown schema type: ${schema["type"]}`: "Couldn't read Schema: no type")
        }
    }
}
