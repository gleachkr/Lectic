import type { JSONSchema } from './schema';
import {
    serialize,
    deserialize,
    validateAgainstSchema,
    strictify,
    destrictify,
    validateJSONSchema,
    isJSONSchema,
} from './schema';
import { expect, it, describe } from "bun:test"

describe('serialize function', () => {
    it('should serialize a valid string', () => {
        const schema: JSONSchema = { type: "string", description: "A string" };
        expect(serialize('hello', schema)).toBe('\n┆hello\n');
    });

describe('null schema', () => {
    it('serializes and deserializes top-level null', () => {
        const schema: JSONSchema = { type: "null" } as const
        const xml = serialize(null, schema)
        expect(xml).toBe('')
        expect(deserialize(xml, schema)).toBe(null)
    })

    it('round-trips null in an object property', () => {
        const schema: JSONSchema = {
            type: "object",
            description: "obj with null",
            properties: {
                x: { type: "null" } as const
            }
        }
        const value = { x: null }
        const xml = serialize(value, schema)
        const back = deserialize(xml, schema)
        expect(back).toEqual(value)
    })

    it('round-trips an array of nulls', () => {
        const schema: JSONSchema = {
            type: "array",
            description: "array of nulls",
            items: { type: "null" } as const
        }
        const value = [null, null]
        const xml = serialize(value, schema)
        const back = deserialize(xml, schema)
        expect(back).toEqual(value)
    })

    it('object schema rejects null (serialize and validate)', () => {
        const objSchema: JSONSchema = {
            type: "object",
            description: "empty object",
            properties: {}
        }
        expect(() => validateAgainstSchema(null, objSchema))
            .toThrow("Invalid object value")
        expect(() => serialize(null, objSchema))
            .toThrow("Invalid object value")
    })
})

    it('should throw error for invalid string', () => {
        const schema: JSONSchema = { type: "string", description: "A string" };
        expect(() => serialize(123, schema)).toThrow("Invalid string value");
    });

    it('should enforce string pattern constraints', () => {
        const schema: JSONSchema = {
            type: "string",
            pattern: "^item-[0-9]+$",
        };

        expect(serialize("item-10", schema)).toBe("\n┆item-10\n");
        expect(() => serialize("item-x", schema))
            .toThrow("Invalid string value");
    });

    it('should enforce boolean enums', () => {
        const schema: JSONSchema = {
            type: "boolean",
            enum: [true],
        };

        expect(serialize(true, schema)).toBe("true");
        expect(() => serialize(false, schema)).toThrow("Invalid boolean value");
    });

    it('should serialize a valid boolean', () => {
        const schema: JSONSchema = { type: "boolean", description: "A boolean" };
        expect(serialize(true, schema)).toBe('true');
    });

    it('should throw error for invalid boolean', () => {
        const schema: JSONSchema = { type: "boolean", description: "A boolean" };
        expect(() => serialize('true', schema)).toThrow("Invalid boolean value");
    });

    it('should serialize a valid number', () => {
        const schema: JSONSchema = { type: "number", description: "A number" };
        expect(serialize(42.5, schema)).toBe('42.5');
    });

    it('should throw error for number outside range', () => {
        const schema: JSONSchema = { type: "number", description: "A number", minimum: 0, maximum: 100 };
        expect(() => serialize(105, schema)).toThrow("Invalid number value");
    });

    it('should serialize a valid integer', () => {
        const schema: JSONSchema = { type: "integer", description: "An integer" };
        expect(serialize(42, schema)).toBe('42');
    });

    it('should throw error for non-integer number', () => {
        const schema: JSONSchema = { type: "integer", description: "An integer" };
        expect(() => serialize(42.5, schema)).toThrow("Invalid integer value");
    });

    it('should serialize an array of strings', () => {
        const schema: JSONSchema = { type: "array", description: "An array", items: { type: "string", description: "String item" } };
        expect(serialize(['item1', 'item2'], schema)).toBe('<array><item>\n┆item1\n</item><item>\n┆item2\n</item></array>');
    });

    it('should throw error for non-array value', () => {
        const schema: JSONSchema = { type: "array", description: "An array", items: { type: "string", description: "String item" } };
        expect(() => serialize('not-an-array', schema)).toThrow("Invalid array value");
    });

    it('should serialize an object with properties', () => {
        const schema: JSONSchema = { type: "object", description: "An object", properties: { 
                key1: { type: "string", description: "A string" }, 
                key2: { type: "number", description: "A number" }
            }
        };
        const obj = { key1: 'value1', key2: 42 };
        expect(serialize(obj, schema)).toBe('<object><key1>\n┆value1\n</key1><key2>42</key2></object>');
    });

    it('should throw an error for integer below minimum constraint', () => {
        const schema: JSONSchema = {
            type: "integer",
            description: "Constrained integer",
            minimum: 10
        };

        expect(() => serialize(5, schema)).toThrow("Invalid integer value");
    });

    it('should throw an error for integer above maximum constraint', () => {
        const schema: JSONSchema = {
            type: "integer",
            description: "Constrained integer",
            maximum: 50
        };

        expect(() => serialize(55, schema)).toThrow("Invalid integer value");
    });

    it('should throw an error for number not in enum', () => {
        const schema: JSONSchema = {
            type: "number",
            description: "Enum number",
            enum: [1.5, 2.5, 3.5]
        };

        expect(() => serialize(4.5, schema)).toThrow("Invalid number value");
    });

    it('should throw an error for string not in enum', () => {
        const schema: JSONSchema = {
            type: "string",
            description: "Enum string",
            enum: ["one", "two", "three"]
        };

        expect(() => serialize('four', schema)).toThrow("Invalid string value");
    });

    it('should throw an error for boolean not recognized', () => {
        const schema: JSONSchema = {
            type: "boolean",
            description: "Boolean value"
        };

        expect(() => serialize('notBoolean', schema)).toThrow("Invalid boolean value");
    });
});

describe('deserialize function', () => {
    it('should deserialize a valid string', () => {
        const schema: JSONSchema = { type: "string", description: "A string" };
        expect(deserialize('\n┆hello\n', schema)).toBe('hello');
    });

    it('should enforce string format constraints', () => {
        const schema: JSONSchema = { type: "string", format: "email" };

        expect(deserialize("\n┆a@example.com\n", schema))
            .toBe("a@example.com");
        expect(() => deserialize("\n┆not-an-email\n", schema))
            .toThrow("Invalid serialized string");
    });

    it('should throw error for invalid literal as string', () => {
        const schema: JSONSchema = { type: "string", description: "A string", enum: ["hello", "world"] };
        expect(() => deserialize('invalidString', schema)).toThrow("Invalid serialized string");
    });

    it('should deserialize a valid boolean', () => {
        const schema: JSONSchema = { type: "boolean", description: "A boolean" };
        expect(deserialize('true', schema)).toBe(true);
    });

    it('should throw error for invalid serialized boolean', () => {
        const schema: JSONSchema = { type: "boolean", description: "A boolean" };
        expect(() => deserialize('notBoolean', schema)).toThrow("Invalid serialized boolean");
    });

    it('should deserialize a valid number', () => {
        const schema: JSONSchema = { type: "number", description: "A number" };
        expect(deserialize('42.5', schema)).toBe(42.5);
    });

    it('should throw error for invalid serialized number', () => {
        const schema: JSONSchema = { type: "number", description: "A number" };
        expect(() => deserialize('notNumber', schema)).toThrow("Invalid serialized number");
    });

    it('should deserialize a valid integer', () => {
        const schema: JSONSchema = { type: "integer", description: "An integer" };
        expect(deserialize('42', schema)).toBe(42);
    });

    it('should deserialize an array of strings', () => {
        const schema: JSONSchema = { type: "array", description: "An array", items: { type: "string", description: "String item" } };
        const xml = '<array><item>\n┆item1\n</item><item>\n┆item2\n</item></array>';
        expect(deserialize(xml, schema)).toEqual(['item1', 'item2']);
    });

    it('should throw error if array items do not match schema', () => {
        const schema: JSONSchema = { type: "array", description: "Array of numbers", items: { type: "number", description: "Number item" } };
        expect(() => deserialize('<array><item>item1</item><item>123</item></array>', schema)).toThrow("Invalid serialized number");
    });

    it('should serialize and deserialize a string value correctly', () => {
        const schema: JSONSchema = { type: "string", description: "A string" };
        const originalValue = 'test';
        const xml = serialize(originalValue, schema);
        const result = deserialize(xml, schema);
        expect(result).toBe(originalValue);
    });

    it('should serialize and deserialize an object value correctly', () => {
        const schema: JSONSchema = {
            type: "object",
            description: "An object",
            properties: { 
                name: { type: "string", description: "A name" },
                age: { type: "integer", description: "An age" }
            }
        };
        const originalValue = { name: 'John Doe', age: 30 };
        const xml = serialize(originalValue, schema);
        const result = deserialize(xml, schema);
        expect(result).toEqual(originalValue);
    });
});

describe('anyOf support', () => {
    it('validates/serializes string or integer union', () => {
        const schema: JSONSchema = {
            anyOf: [
                { type: 'string', description: 'a string' },
                { type: 'integer', description: 'an int' }
            ]
        } as const
        expect(serialize('x', schema)).toBe('\n┆x\n')
        expect(serialize(7, schema)).toBe('7')
        expect(() => serialize(true, schema)).toThrow('anyOf')

        expect(deserialize('\n┆hey\n', schema)).toBe('hey')
        expect(deserialize('42', schema)).toBe(42)
        expect(() => deserialize('true', schema)).toThrow('anyOf')
    })

    it('works nested inside object properties', () => {
        const schema: JSONSchema = {
            type: 'object',
            description: 'obj',
            properties: {
                val: {
                    anyOf: [
                        { type: 'array', description: 'arr', items: { type: 'string', description: 's' } },
                        { type: 'object', description: 'o', properties: { n: { type: 'number', description: 'n' } } }
                    ]
                }
            }
        }

        const xml1 = serialize({ val: ['a', 'b'] }, schema)
        const back1 = deserialize(xml1, schema)
        expect(back1).toEqual({ val: ['a', 'b'] })

        const xml2 = serialize({ val: { n: 1.5 } }, schema)
        const back2 = deserialize(xml2, schema)
        expect(back2).toEqual({ val: { n: 1.5 } })
    })

    it('handles anyOf for array items', () => {
        const schema: JSONSchema = {
            type: 'array',
            description: 'mixed',
            items: {
                anyOf: [
                    { type: 'string', description: 's' },
                    { type: 'integer', description: 'i' }
                ]
            }
        }
        const value = ['a', 1, 'b', 2]
        const xml = serialize(value, schema)
        const back = deserialize(xml, schema)
        expect(back).toEqual(value)
    })
})

describe('Round-trip serialization/deserialization tests', () => {
    it('should handle complex objects with nested arrays and objects', () => {
        const schema: JSONSchema = {
            type: "object",
            description: "Complex object",
            properties: {
                user: {
                    type: "object",
                    description: "User details",
                    properties: {
                        id: { type: "integer", description: "User ID" },
                        name: { type: "string", description: "User Name" },
                        roles: {
                            type: "array",
                            description: "Roles array",
                            items: { type: "string", description: "Role type" }
                        }
                    }
                },
                isActive: { type: "boolean", description: "Active status" },
                metadata: {
                    type: "object",
                    description: "Additional metadata",
                    properties: {
                        created: { type: "number", description: "Creation timestamp" },
                        flags: {
                            type: "array",
                            description: "Flags",
                            items: { type: "boolean", description: "Flag status" }
                        }
                    }
                }
            }
        };

        const originalValue = {
            user: {
                id: 1,
                name: 'Alice',
                roles: ['admin', 'editor']
            },
            isActive: true,
            metadata: {
                created: 1632838479,
                flags: [true, false, true]
            }
        };

        const xml = serialize(originalValue, schema);
        const result = deserialize(xml, schema);
        expect(result).toEqual(originalValue);
    });

    it('should manage nested arrays within objects', () => {
        const schema: JSONSchema = {
            type: "object",
            description: "Object with nested arrays",
            properties: {
                dataSet: {
                    type: "array",
                    description: "Array of data points",
                    items: {
                        type: "object",
                        description: "Data Point",
                        properties: {
                            id: { type: "integer", description: "Point ID" },
                            values: {
                                type: "array",
                                description: "Value list",
                                items: { type: "number", description: "Measurement value" }
                            }
                        }
                    }
                }
            }
        };

        const originalValue = {
            dataSet: [
                { id: 1, values: [1.1, 1.2, 1.3] },
                { id: 2, values: [2.1, 2.2, 2.3] }
            ]
        };

        const xml = serialize(originalValue, schema);
        const result = deserialize(xml, schema);
        expect(result).toEqual(originalValue);
    });

    it('should handle complex data types with enum constraints', () => {
        const schema: JSONSchema = {
            type: "object",
            description: "Object with enums",
            properties: {
                status: {
                    type: "string",
                    description: "Object status",
                    enum: ["active", "inactive", "pending"]
                },
                codes: {
                    type: "array",
                    description: "Code list",
                    items: {
                        type: "integer",
                        description: "Code",
                        enum: [100, 200, 300]
                    }
                }
            }
        };

        const originalValue = {
            status: "active",
            codes: [100, 200]
        };

        const xml = serialize(originalValue, schema);
        const result = deserialize(xml, schema);
        expect(result).toEqual(originalValue);
    });

    it('should serialize and deserialize objects with array and boolean types correctly', () => {
        const schema: JSONSchema = {
            type: "object",
            description: "Contains arrays and booleans",
            properties: {
                categories: {
                    type: "array",
                    description: "Category list",
                    items: { type: "string", description: "Category name" }
                },
                isEnabled: { type: "boolean", description: "Enabled flag" }
            }
        };

        const originalValue = {
            categories: ['Home', 'Garden'],
            isEnabled: true
        };

        const xml = serialize(originalValue, schema);
        const result = deserialize(xml, schema);
        expect(result).toEqual(originalValue);
    });

    it('should process objects with default schema constraints', () => {
        const schema: JSONSchema = {
            type: "object",
            description: "Basic schema",
            properties: {
                name: { type: "string", description: "Name" },
                level: { type: "integer", description: "Access level", minimum: 1, maximum: 10 },
                tags: {
                    type: "array",
                    description: "Tags array",
                    items: { type: "string", description: "Tag" }
                }
            }
        };

        const originalValue = {
            name: 'Test',
            level: 5,
            tags: ['t1', 't2']
        };

        const xml = serialize(originalValue, schema);
        const result = deserialize(xml, schema);
        expect(result).toEqual(originalValue);
    });

    it('should handle a deeply nested structure without optional fields', () => {
        const schema: JSONSchema = {
            type: "object",
            description: "Deeply nested object",
            properties: {
                level1: {
                    type: "object",
                    description: "Level 1",
                    properties: {
                        level2: {
                            type: "object",
                            description: "Level 2",
                            properties: {
                                level3: {
                                    type: "object",
                                    description: "Level 3",
                                    properties: {
                                        value: { type: "integer", description: "Deep value" }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        };

        const originalValue = {
            level1: {
                level2: {
                    level3: {
                        value: 99
                    }
                }
            }
        };

        const xml = serialize(originalValue, schema);
        const result = deserialize(xml, schema);
        expect(result).toEqual(originalValue);
    });

    it('should process an object with arrays of numbers', () => {
        const schema: JSONSchema = {
            type: "object",
            description: "Object containing number arrays",
            properties: {
                metrics: {
                    type: "array",
                    description: "Metric values",
                    items: { type: "number", description: "Numerical metric" }
                },
                active: { type: "boolean", description: "Active status" }
            }
        };

        const originalValue = {
            metrics: [18.6, 22.4, 35.3],
            active: false
        };

        const xml = serialize(originalValue, schema);
        const result = deserialize(xml, schema);
        expect(result).toEqual(originalValue);
    });

    it('should handle integer fields with value constraints', () => {
        const schema: JSONSchema = {
            type: "object",
            description: "Object with constrained integers",
            properties: {
                minValue: { type: "integer", description: "Minimum value", minimum: 0 },
                maxValue: { type: "integer", description: "Maximum value", maximum: 100 }
            }
        };

        const originalValue = {
            minValue: 5,
            maxValue: 95
        };

        const xml = serialize(originalValue, schema);
        const result = deserialize(xml, schema);
        expect(result).toEqual(originalValue);
    });

    it('should serialize and deserialize strings and enumerated integers', () => {
        const schema: JSONSchema = {
            type: "object",
            description: "Object with enumerated integers",
            properties: {
                status: {
                    type: "string",
                    description: "Status description",
                    enum: ["new", "in-progress", "complete"]
                },
                code: {
                    type: "integer",
                    description: "Status code",
                    enum: [1, 2, 3]
                }
            }
        };

        const originalValue = {
            status: "in-progress",
            code: 2
        };

        const xml = serialize(originalValue, schema);
        const result = deserialize(xml, schema);
        expect(result).toEqual(originalValue);
    });

    it('should handle objects with nested arrays of strings', () => {
        const schema: JSONSchema = {
            type: "object",
            description: "Object with nested string arrays",
            properties: {
                teams: {
                    type: "array",
                    description: "Team lists",
                    items: {
                        type: "array",
                        description: "Team members",
                        items: { type: "string", description: "Member name" }
                    }
                }
            }
        };

        const originalValue = {
            teams: [
                ["Alice", "Bob"],
                ["Charlie", "Dave"]
            ]
        };

        const xml = serialize(originalValue, schema);
        const result = deserialize(xml, schema);
        expect(result).toEqual(originalValue);
    });

    it('should handle objects with shared keys in nested objects', () => {
        const schema: JSONSchema = {
            type: "object",
            description: "Object with nested objects sharing keys",
            properties: {
                name: { type: "string", description: "Top-level name" },
                nested: {
                    type: "object",
                    description: "Nested object",
                    properties: {
                        name: { type: "string", description: "Nested name" }
                    }
                }
            }
        };

        const originalValue = {
            name: "TopLevelName",
            nested: {
                name: "NestedName"
            }
        };

        const xml = serialize(originalValue, schema);
        const result = deserialize(xml, schema);
        expect(result).toEqual(originalValue);
    });

});

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

    describe('validateJSONSchema', () => {
        it('accepts a simple object schema', () => {
            const s: unknown = {
                type: "object",
                properties: {
                    a: { type: "string" },
                },
                required: ["a"],
                additionalProperties: false,
            }
            expect(validateJSONSchema(s)).toBeTrue()
            expect(isJSONSchema(s)).toBeTrue()
        })

        it('rejects non-objects', () => {
            expect(isJSONSchema(123)).toBeFalse()
            expect(() => validateJSONSchema(123))
                .toThrow('Expected object')
        })

        it('accepts supported string format and pattern', () => {
            const s: unknown = {
                type: "string",
                format: "email",
                pattern: "^[^@]+@[^@]+$",
            }
            expect(validateJSONSchema(s)).toBeTrue()
            expect(isJSONSchema(s)).toBeTrue()
        })

        it('rejects invalid regex patterns', () => {
            const s: unknown = {
                type: "string",
                pattern: "[unterminated",
            }
            expect(isJSONSchema(s)).toBeFalse()
            expect(() => validateJSONSchema(s))
                .toThrow('Invalid regex pattern')
        })

        it('rejects unsupported string formats', () => {
            const s: unknown = {
                type: "string",
                format: "uri",
            }
            expect(isJSONSchema(s)).toBeFalse()
            expect(() => validateJSONSchema(s))
                .toThrow('Unsupported format')
        })

        it('accepts boolean and null enums', () => {
            const b: unknown = {
                type: "boolean",
                enum: [true, false],
            }
            const n: unknown = {
                type: "null",
                enum: [null],
            }
            expect(validateJSONSchema(b)).toBeTrue()
            expect(validateJSONSchema(n)).toBeTrue()
        })

        it('rejects unknown keys', () => {
            const s: unknown = {
                type: "string",
                no_such_key: true,
            }
            expect(isJSONSchema(s)).toBeFalse()
            expect(() => validateJSONSchema(s)).toThrow('Unknown key')
        })
    })
})
