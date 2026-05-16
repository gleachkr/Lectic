import type { JSONSchema } from './schema';
import {
    strictify,
    destrictify,
    supportsOpenAIStrictMode,
    openAIToolSchema,
} from './openaiSchema';
import { expect, it, describe } from "bun:test"

describe('oai strictify/destrictify', () => {
    it('strictify makes optional properties nullable and required', () => {
        const schema: JSONSchema = {
            type: "object",
            description: "root",
            properties: {
                a: { type: "string", description: "a" },
                b: { type: "string", description: "b" },
            },
            required: ["a"],
        }

        const strict = strictify(schema)
        expect(strict).toMatchObject({
            type: "object",
            required: ["a", "b"],
            additionalProperties: false,
        })

        const b = (strict as any).properties.b
        expect(Array.isArray(b.anyOf)).toBe(true)
        expect((b.anyOf as any[]).some((s: any) => s.type === "null"))
            .toBe(true)
    })

    it('strictify does not double-wrap already nullable properties', () => {
        const schema: JSONSchema = {
            type: "object",
            description: "root",
            properties: {
                a: { type: "string", description: "a" },
                b: {
                    anyOf: [
                        { type: "string", description: "b" },
                        { type: "null" },
                    ],
                },
            },
            required: ["a"],
        }

        const strict = strictify(schema) as any
        const b = strict.properties.b
        expect(Array.isArray(b.anyOf)).toBe(true)
        expect((b.anyOf as any[]).filter((s: any) => s.type === "null").length)
            .toBe(1)
    })

    it('uses non-strict mode for schemas strict mode cannot represent', () => {
        const schema = {
            type: "object",
            properties: {
                data: {
                    type: "object",
                    propertyNames: { type: "string" },
                    additionalProperties: { type: "string" },
                },
            },
        } as JSONSchema

        expect(supportsOpenAIStrictMode(schema)).toBeFalse()
        expect(openAIToolSchema(schema)).toEqual({
            strict: false,
            schema,
        })
    })

    it('uses strict mode for schemas strict mode can represent', () => {
        const schema: JSONSchema = {
            type: "object",
            properties: {
                required: { type: "string" },
                optional: { type: "number" },
            },
            required: ["required"],
        }

        expect(supportsOpenAIStrictMode(schema)).toBeTrue()
        expect(openAIToolSchema(schema)).toEqual({
            strict: true,
            schema: {
                type: "object",
                properties: {
                    required: { type: "string" },
                    optional: {
                        anyOf: [
                            { type: "number" },
                            { type: "null" },
                        ],
                    },
                },
                required: ["required", "optional"],
                additionalProperties: false,
            },
        })
    })

    it('strictify tolerates object schemas without properties', () => {
        const schema: JSONSchema = {
            type: "object",
            additionalProperties: false,
        }

        expect(strictify(schema)).toEqual({
            type: "object",
            properties: {},
            required: [],
            additionalProperties: false,
        })
    })

    it('destrictify removes null optional properties', () => {
        const schema: JSONSchema = {
            type: "object",
            description: "root",
            properties: {
                a: { type: "string", description: "a" },
                b: { type: "string", description: "b" },
            },
            required: ["a"],
        }

        const value = { a: "x", b: null }
        expect(destrictify(value, schema)).toEqual({ a: "x" })
    })

    it('destrictify removes nulls in nested optional object properties', () => {
        const schema: JSONSchema = {
            type: "object",
            description: "root",
            properties: {
                nested: {
                    type: "object",
                    description: "nested",
                    properties: {
                        x: { type: "string", description: "x" },
                    },
                    required: [],
                },
            },
            required: ["nested"],
        }

        const value = { nested: { x: null } }
        expect(destrictify(value, schema)).toEqual({ nested: {} })
    })
})
