import { isIP } from "node:net"
import {
    unwrap,
    extractElements,
    escapeTags,
    unescapeTags,
    escapeXmlAttribute,
    unescapeXmlAttribute,
} from "../parsing/xml.ts"
import { isObjectRecord } from "./guards.ts"

type StringFormat =
    | "date-time"
    | "time"
    | "date"
    | "duration"
    | "email"
    | "hostname"
    | "ipv4"
    | "ipv6"
    | "uuid"

type StringSchema = {
    type: "string",
    description?: string
    enum? : string[]
    pattern?: string
    format?: StringFormat
    contentMediaType?: string
}

const SUPPORTED_STRING_FORMATS = new Set<StringFormat>([
    "date-time",
    "time",
    "date",
    "duration",
    "email",
    "hostname",
    "ipv4",
    "ipv6",
    "uuid",
])

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

function isValidRegexPattern(pattern: string): boolean {
    try {
        void new RegExp(pattern)
        return true
    } catch {
        return false
    }
}

function isSupportedStringFormat(value: string): value is StringFormat {
    return SUPPORTED_STRING_FORMATS.has(value as StringFormat)
}

function matchesStringFormat(value: string, format?: StringFormat): boolean {
    if (format === undefined) return true

    switch (format) {
        case "date-time": {
            const dateTimeRe =
                /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/
            return dateTimeRe.test(value) && !Number.isNaN(Date.parse(value))
        }
        case "time": {
            const timeRe = /^\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/
            return timeRe.test(value)
        }
        case "date": {
            const dateRe = /^(\d{4})-(\d{2})-(\d{2})$/
            const m = dateRe.exec(value)
            if (m === null) return false
            const y = Number(m[1])
            const mon = Number(m[2])
            const d = Number(m[3])
            const dt = new Date(Date.UTC(y, mon - 1, d))
            return dt.getUTCFullYear() === y
                && dt.getUTCMonth() === mon - 1
                && dt.getUTCDate() === d
        }
        case "duration": {
            const durationRe =
                /^P(?=.)(?:\d+Y)?(?:\d+M)?(?:\d+W)?(?:\d+D)?(?:T(?=.)(?:\d+H)?(?:\d+M)?(?:\d+(?:\.\d+)?S)?)?$/
            return durationRe.test(value)
        }
        case "email": {
            const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
            return emailRe.test(value)
        }
        case "hostname": {
            if (value.length === 0 || value.length > 253) return false
            const labels = value.split(".")
            return labels.every((label) => {
                if (label.length === 0 || label.length > 63) return false
                if (label.startsWith("-") || label.endsWith("-")) return false
                return /^[A-Za-z0-9-]+$/.test(label)
            })
        }
        case "ipv4":
            return isIP(value) === 4
        case "ipv6":
            return isIP(value) === 6
        case "uuid": {
            const uuidRe =
                /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
            return uuidRe.test(value)
        }
        default:
            // Some external schemas (e.g. MCP tool schemas) may include
            // formats outside Lectic's validated subset. Ignore them here.
            return true
    }
}

function matchesStringPattern(value: string, pattern?: string): boolean {
    if (pattern === undefined) return true
    try {
        return new RegExp(pattern).test(value)
    } catch {
        // Keep external schemas usable even if their regex flavor differs.
        return true
    }
}

function validateStringValue(arg: unknown, schema: StringSchema): arg is string {
    return typeof arg === "string"
        && (!schema.enum || schema.enum.includes(arg))
        && matchesStringPattern(arg, schema.pattern)
        && matchesStringFormat(arg, schema.format)
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
                    new Set([
                        "type",
                        "enum",
                        "pattern",
                        "format",
                        "contentMediaType",
                        ...baseAllowed,
                    ]),
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

                const patternVal = obj["pattern"]
                if ("pattern" in obj && typeof patternVal !== "string") {
                    throw new Error(
                        `Expected string at ${schemaPath([...path, "pattern"])}`
                    )
                }
                if (
                    typeof patternVal === "string"
                    && !isValidRegexPattern(patternVal)
                ) {
                    throw new Error(
                        `Invalid regex pattern at ${schemaPath([...path, "pattern"])}`
                    )
                }

                const formatVal = obj["format"]
                if ("format" in obj && typeof formatVal !== "string") {
                    throw new Error(
                        `Expected string at ${schemaPath([...path, "format"])}`
                    )
                }
                if (
                    typeof formatVal === "string"
                    && !isSupportedStringFormat(formatVal)
                ) {
                    throw new Error(
                        `Unsupported format "${formatVal}" at `
                        + schemaPath([...path, "format"])
                    )
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
                    new Set(["type", "enum", ...baseAllowed]),
                    schemaPath(path)
                )

                const enumVal = obj["enum"]
                if ("enum" in obj && !Array.isArray(enumVal)) {
                    throw new Error(`Expected array at ${schemaPath([...path, "enum"])}`)
                }
                if (
                    Array.isArray(enumVal)
                    && !enumVal.every((x) => typeof x === "boolean")
                ) {
                    throw new Error(`Expected boolean[] at ${schemaPath([...path, "enum"])}`)
                }
                break
            }

            case "null": {
                assertNoUnknownKeys(
                    obj,
                    new Set(["type", "enum", ...baseAllowed]),
                    schemaPath(path)
                )

                const enumVal = obj["enum"]
                if ("enum" in obj && !Array.isArray(enumVal)) {
                    throw new Error(`Expected array at ${schemaPath([...path, "enum"])}`)
                }
                if (
                    Array.isArray(enumVal)
                    && !enumVal.every((x) => x === null)
                ) {
                    throw new Error(`Expected null[] at ${schemaPath([...path, "enum"])}`)
                }
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
                        "propertyNames",
                        ...baseAllowed,
                    ]),
                    schemaPath(path),
                )

                const propsVal = obj["properties"]
                if ("properties" in obj) {
                    if (!isObjectRecord(propsVal)) {
                        throw new Error(
                            `Expected object at ${schemaPath([...path, "properties"])}`
                        )
                    }
                    for (const [k, child] of Object.entries(propsVal)) {
                        visit(child, [...path, "properties", k])
                    }
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
                if (
                    "additionalProperties" in obj
                    && typeof apVal !== "boolean"
                ) {
                    visit(apVal, [...path, "additionalProperties"])
                }

                if ("propertyNames" in obj) {
                    visit(obj["propertyNames"], [...path, "propertyNames"])
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
    enum? : boolean[]
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
    description?: string
    enum?: null[]
}

export type ObjectSchema = {
    type: "object",
    description?: string
    required?: string[]
    properties?: Record<string, JSONSchema>
    additionalProperties?: boolean | JSONSchema
    propertyNames?: JSONSchema
}

type AnyOfSchema = {
    anyOf: JSONSchema[]
    description?: string
}

function isSchemaAdditionalProperties(
    value: boolean | JSONSchema | undefined
): value is JSONSchema {
    return isObjectRecord(value)
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
            if (!validateStringValue(arg, schema)) {
                throw new Error(`Invalid string value: ${arg}`)
            }
            return escapeTags(arg)
        }

        case "boolean": {
            if (
                typeof arg !== "boolean"
                || (schema.enum && !schema.enum.includes(arg))
            ) {
                throw new Error(`Invalid boolean value: ${arg}`)
            }
            return arg.toString()
        }

        case "null": {
            if (arg !== null || (schema.enum && !schema.enum.includes(arg))) {
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
            const properties = schema.properties ?? {}
            const obj = arg as Record<string, unknown>
            const known = Object.keys(properties).map(key => {
                if (!(key in obj)) return ""
                if (schema.propertyNames) {
                    validateAgainstSchema(key, schema.propertyNames)
                }
                const keySchema = properties[key]
                const attr = "type" in keySchema && keySchema.type === "string" && keySchema.contentMediaType
                    ? ` contentMediaType="${keySchema.contentMediaType}"`
                    : ""
                return `<${key}${attr}>${serialize(obj[key], properties[key])}</${key}>`
            })
            const dynamic = Object.keys(obj)
                .filter((key) => !(key in properties))
                .map((key) => {
                    if (schema.propertyNames) {
                        validateAgainstSchema(key, schema.propertyNames)
                    }
                    const additional = schema.additionalProperties
                    if (additional === false) {
                        throw new Error(`Invalid object property: ${key}`)
                    }
                    const keyAttr = escapeXmlAttribute(key)
                    if (isSchemaAdditionalProperties(additional)) {
                        return `<entry key="${keyAttr}">` +
                            `${serialize(obj[key], additional)}</entry>`
                    }
                    return `<entry key="${keyAttr}">` +
                        `${escapeTags(JSON.stringify(obj[key]))}</entry>`
                })
            return `<object>${known.join('')}${dynamic.join('')}</object>`

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
            if (!validateStringValue(arg, schema)) {
                throw new Error(`Invalid string value: ${arg}`)
            }
            return true
        }

        case "boolean": {
            if (
                typeof arg !== "boolean"
                || (schema.enum && !schema.enum.includes(arg))
            ) {
                throw new Error(`Invalid boolean value: ${arg}`)
            }
            return true
        }

        case "null": {
            if (arg !== null || (schema.enum && !schema.enum.includes(arg))) {
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
            const properties = schema.properties ?? {}
            const required = schema.required || []
            const obj = arg as Record<string, unknown>
            for (const key of required) {
                if (!(key in obj)) {
                    throw new Error(`Missing required property: ${key}`)
                }
            }
            return Object.keys(obj).every(key => {
                if (
                    schema.propertyNames
                    && !validateAgainstSchema(key, schema.propertyNames)
                ) {
                    return false
                }
                if (key in properties) {
                    return validateAgainstSchema(obj[key], properties[key])
                }
                const additional = schema.additionalProperties
                if (additional === false) {
                    throw new Error(`Invalid object property: ${key}`)
                }
                if (isSchemaAdditionalProperties(additional)) {
                    return validateAgainstSchema(obj[key], additional)
                }
                return true
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
            if (!validateStringValue(unescaped, schema)) {
                throw new Error("Invalid serialized string")
            }
            return unescaped
        }

        case "null":
            xml = xml.trim()
            if (
                xml === ""
                && (!schema.enum || schema.enum.includes(null))
            ) {
                return null
            }
            throw new Error("Invalid serialized null")

        case "boolean": {
            xml = xml.trim()
            if (xml === "true") {
                if (schema.enum && !schema.enum.includes(true)) {
                    throw new Error("Invalid serialized boolean")
                }
                return true
            }
            if (xml === "false") {
                if (schema.enum && !schema.enum.includes(false)) {
                    throw new Error("Invalid serialized boolean")
                }
                return false
            }
            throw new Error("Invalid serialized boolean")
        }

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
                if (/^<entry\b[^>]*\bkey="/.test(element)) {
                    const match = /\bkey="([^"]*)"/.exec(element)
                    if (!match) {
                        throw new Error(`Malformed dynamic object key: ${element}`)
                    }
                    const key = unescapeXmlAttribute(match[1])
                    if (schema.propertyNames) {
                        validateAgainstSchema(key, schema.propertyNames)
                    }
                    if (key in obj) {
                        throw new Error(`Duplicated property: ${key} on ${xml}`)
                    }
                    const additional = schema.additionalProperties
                    if (additional === false) {
                        throw new Error(`Unrecognized property: ${key} on ${xml}`)
                    }
                    const entry = unwrap(element, "entry")
                    obj[key] = isSchemaAdditionalProperties(additional)
                        ? deserialize(entry, additional)
                        : JSON.parse(unescapeTags(entry))
                    continue
                }

                // Extract only the tag name, ignoring any attributes.
                const keyNameRegex = /^<([a-zA-Z][a-zA-Z0-9_]*)\b/
                const keyMatch = keyNameRegex.exec(element)
                if (keyMatch === null) {
                    //should be unreachable
                    throw new Error(`Malformed object key: "${element}" on ${xml}`)
                }
                const key = keyMatch[1]
                if (schema.propertyNames) {
                    validateAgainstSchema(key, schema.propertyNames)
                }
                const properties = schema.properties ?? {}
                if (!(key in properties)) {
                    throw new Error(`Unrecognized property: ${key} on ${xml}`)
                }
                if (key in obj) {
                    throw new Error(`Duplicated property: ${key} on ${xml}`)
                }
                obj[key] = deserialize(unwrap(element, key), properties[key])
            }
            return obj
        }

        default: {
            throw new Error("type" in schema ? `Unknown schema type: ${schema["type"]}`: "Couldn't read Schema: no type")
        }
    }
}
