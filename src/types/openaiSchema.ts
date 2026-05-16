import type { JSONSchema } from "./schema.ts"
import { isObjectRecord } from "./guards.ts"

function hasOnlyKeys(value: Record<string, unknown>, keys: Set<string>) {
    return Object.keys(value).every((key) => keys.has(key))
}

function isAnyOf(schema: JSONSchema): schema is Extract<
    JSONSchema,
    { anyOf: JSONSchema[] }
> {
    return "anyOf" in schema && schema.anyOf !== undefined
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
        return anyOf.find((s) => "type" in s && s.type === "array")
            ?? anyOf[0]
    }

    if (isObjectRecord(value)) {
        return anyOf.find((s) => "type" in s && s.type === "object")
            ?? anyOf[0]
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
                (s) =>
                    "type" in s
                    && (s.type === "integer" || s.type === "number")
            )
            return exact ?? fallback ?? anyOf[0]
        }
        default:
            return anyOf[0]
    }
}

export function supportsOpenAIStrictMode(schema: unknown): boolean {
    const visit = (value: unknown): boolean => {
        if (!isObjectRecord(value)) return false

        if ("anyOf" in value) {
            const anyOf = value["anyOf"]
            const allowed = new Set(["anyOf", "description", "default"])
            return hasOnlyKeys(value, allowed)
                && Array.isArray(anyOf)
                && anyOf.every(visit)
        }

        const type = value["type"]
        if (typeof type !== "string") return false

        switch (type) {
            case "string":
                return hasOnlyKeys(value, new Set([
                    "type",
                    "enum",
                    "pattern",
                    "format",
                    "contentMediaType",
                    "description",
                    "default",
                ]))
            case "number":
            case "integer":
                return hasOnlyKeys(value, new Set([
                    "type",
                    "enum",
                    "minimum",
                    "maximum",
                    "description",
                    "default",
                ]))
            case "boolean":
            case "null":
                return hasOnlyKeys(value, new Set([
                    "type",
                    "enum",
                    "description",
                    "default",
                ]))
            case "array":
                return hasOnlyKeys(value, new Set([
                    "type",
                    "items",
                    "description",
                    "default",
                ])) && visit(value["items"])
            case "object": {
                const allowed = new Set([
                    "type",
                    "properties",
                    "required",
                    "additionalProperties",
                    "description",
                    "default",
                ])
                if (!hasOnlyKeys(value, allowed)) return false
                if (
                    "additionalProperties" in value
                    && value["additionalProperties"] !== false
                ) {
                    return false
                }
                if (
                    "required" in value
                    && !(
                        Array.isArray(value["required"])
                        && value["required"].every(
                            (x) => typeof x === "string"
                        )
                    )
                ) {
                    return false
                }
                if (!("properties" in value)) return true
                if (!isObjectRecord(value["properties"])) return false
                return Object.values(value["properties"]).every(visit)
            }
            default:
                return false
        }
    }

    return visit(schema)
}

export function openAIToolSchema(schema: JSONSchema): {
    strict: boolean
    schema: JSONSchema
} {
    if (!supportsOpenAIStrictMode(schema)) {
        return { strict: false, schema }
    }
    return { strict: true, schema: strictify(schema) }
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
export function strictify(schema: JSONSchema): JSONSchema {
    let rslt: JSONSchema
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
            case "null":
                rslt = schema
                break
            case "array":
                rslt = {
                    ...schema,
                    items: strictify(schema.items),
                }
                break
            case "object": {
                const properties = schema.properties ?? {}
                const required = schema.required ?? []
                const strictProps = Object.fromEntries(
                    Object.entries(properties).map(([k, v]) => {
                        let prop = strictify(v)
                        if (!required.includes(k)) {
                            prop = makeNullable(prop)
                        }
                        return [k, prop]
                    })
                )

                rslt = {
                    type: "object",
                    ...(schema.description
                        ? { description: schema.description }
                        : {}),
                    properties: strictProps,
                    required: Object.keys(properties),
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
                const propSchema = schema.properties?.[k]
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
