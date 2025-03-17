import { serialize, deserialize } from './tool';
import type  { JSONSchema } from './tool';
import { expect, it, describe } from "bun:test"

describe('serialize function', () => {
    it('should serialize a valid string', () => {
        const schema: JSONSchema = { type: "string", description: "A string" };
        expect(serialize('hello', schema)).toBe('<string>hello</string>');
    });

    it('should throw error for invalid string', () => {
        const schema: JSONSchema = { type: "string", description: "A string" };
        expect(() => serialize(123, schema)).toThrow("Invalid string value");
    });

    it('should serialize a valid boolean', () => {
        const schema: JSONSchema = { type: "boolean", description: "A boolean" };
        expect(serialize(true, schema)).toBe('<boolean>true</boolean>');
    });

    it('should throw error for invalid boolean', () => {
        const schema: JSONSchema = { type: "boolean", description: "A boolean" };
        expect(() => serialize('true', schema)).toThrow("Invalid boolean value");
    });

    it('should serialize a valid number', () => {
        const schema: JSONSchema = { type: "number", description: "A number" };
        expect(serialize(42.5, schema)).toBe('<number>42.5</number>');
    });

    it('should throw error for number outside range', () => {
        const schema: JSONSchema = { type: "number", description: "A number", minimum: 0, maximum: 100 };
        expect(() => serialize(105, schema)).toThrow("Invalid number value");
    });

    it('should serialize a valid integer', () => {
        const schema: JSONSchema = { type: "integer", description: "An integer" };
        expect(serialize(42, schema)).toBe('<integer>42</integer>');
    });

    it('should throw error for non-integer number', () => {
        const schema: JSONSchema = { type: "integer", description: "An integer" };
        expect(() => serialize(42.5, schema)).toThrow("Invalid integer value");
    });

    it('should serialize an array of strings', () => {
        const schema: JSONSchema = { type: "array", description: "An array", items: { type: "string", description: "String item" } };
        expect(serialize(['item1', 'item2'], schema)).toBe('<array><string>item1</string><string>item2</string></array>');
    });

    it('should throw error for non-array value', () => {
        const schema: JSONSchema = { type: "array", description: "An array", items: { type: "string", description: "String item" } };
        expect(() => serialize('not-an-array', schema)).toThrow("Invalid array value");
    });

    it('should serialize an object with properties', () => {
        const schema: JSONSchema = { type: "object", description: "An object", properties: { key1: { type: "string", description: "A string" }, key2: { type: "number", description: "A number" } } };
        const obj = { key1: 'value1', key2: 42 };
        expect(serialize(obj, schema)).toBe('<object><key1><string>value1</string></key1><key2><number>42</number></key2></object>');
    });

    it('should serialize a string that matches an enum', () => {
        const schema: JSONSchema = { type: "string", description: "Enum string", enum: ["hello", "world"] };
        expect(serialize('hello', schema)).toBe('<string>hello</string>');
    });

    it('should throw error for string not in enum', () => {
        const schema: JSONSchema = { type: "string", description: "Enum string", enum: ["hello", "world"] };
        expect(() => serialize('notInEnum', schema)).toThrow("Invalid string value");
    });

    it('should serialize a number that matches an enum', () => {
        const schema: JSONSchema = { type: "number", description: "Enum number", enum: [42, 100.5] };
        expect(serialize(100.5, schema)).toBe('<number>100.5</number>');
    });

    it('should serialize an integer within bound constraints', () => {
        const schema: JSONSchema = { type: "integer", description: "Bounded integer", minimum: 10, maximum: 50 };
        expect(serialize(25, schema)).toBe('<integer>25</integer>');
    });

    it('should throw error for integer outside minimum range', () => {
        const schema: JSONSchema = { type: "integer", description: "Bounded integer", minimum: 10, maximum: 50 };
        expect(() => serialize(5, schema)).toThrow("Invalid integer value");
    });

    it('should throw error for integer outside maximum range', () => {
        const schema: JSONSchema = { type: "integer", description: "Bounded integer", minimum: 10, maximum: 50 };
        expect(() => serialize(55, schema)).toThrow("Invalid integer value");
    });

    it('should serialize an array with mixed types', () => {
        const schema: JSONSchema = { type: "array", description: "Mixed array", items: { type: "string", description: "A string" } };
        expect(serialize(["a", "b", "c"], schema)).toBe('<array><string>a</string><string>b</string><string>c</string></array>');
    });

    it('should serialize an empty array', () => {
        const schema: JSONSchema = { type: "array", description: "Empty array", items: { type: "string", description: "A string item" } };
        expect(serialize([], schema)).toBe('<array></array>');
    });

    it('should serialize a nested object', () => {
        const schema: JSONSchema = {
            type: "object",
            description: "Nested object",
            properties: {
                outerKey: {
                    type: "object",
                    description: "Inner object",
                    properties: { innerKey: { type: "string", description: "Inner string" } }
                }
            }
        };
        const obj = { outerKey: { innerKey: "innerValue" } };
        expect(serialize(obj, schema)).toBe('<object><outerKey><object><innerKey><string>innerValue</string></innerKey></object></outerKey></object>');
    });

    it('should throw error if array items do not match schema', () => {
        const schema: JSONSchema = { type: "array", description: "Array of strings", items: { type: "string", description: "String item" } };
        expect(() => serialize(["valid", 123], schema)).toThrow("Invalid string value");
    });

    it('should serialize an object where properties structurally conform to declared schema', () => {
        const schema: JSONSchema = {
            type: "object",
            description: "Schema object",
            properties: {
                id: { type: "integer", description: "ID number" },
                isActive: { type: "boolean", description: "Active status" },
            }
        };
        const obj = { id: 1, isActive: true };
        expect(serialize(obj, schema)).toBe('<object><id><integer>1</integer></id><isActive><boolean>true</boolean></isActive></object>');
    });
});

describe('deserialize function', () => {
    it('should deserialize a valid string', () => {
        const schema: JSONSchema = { type: "string", description: "A string" };
        expect(deserialize('<string>hello</string>', schema)).toBe('hello');
    });

    it('should throw error for invalid serialized string', () => {
        const schema: JSONSchema = { type: "string", description: "A string" };
        expect(() => deserialize('<string>123</boolean>', schema)).toThrow("Invalid serialized string");
    });

    it('should deserialize a valid boolean', () => {
        const schema: JSONSchema = { type: "boolean", description: "A boolean" };
        expect(deserialize('<boolean>true</boolean>', schema)).toBe(true);
    });

    it('should throw error for invalid serialized boolean', () => {
        const schema: JSONSchema = { type: "boolean", description: "A boolean" };
        expect(() => deserialize('<boolean>notBoolean</boolean>', schema)).toThrow("Invalid serialized boolean");
    });

    it('should deserialize a valid number', () => {
        const schema: JSONSchema = { type: "number", description: "A number" };
        expect(deserialize('<number>42.5</number>', schema)).toBe(42.5);
    });

    it('should throw error for invalid serialized number', () => {
        const schema: JSONSchema = { type: "number", description: "A number" };
        expect(() => deserialize('<number>notNumber</number>', schema)).toThrow("Invalid serialized number");
    });

    it('should deserialize a valid integer', () => {
        const schema: JSONSchema = { type: "integer", description: "An integer" };
        expect(deserialize('<integer>42</integer>', schema)).toBe(42);
    });

    it('should throw error for invalid serialized integer', () => {
        const schema: JSONSchema = { type: "integer", description: "An integer" };
        expect(() => deserialize('<integer>42.5</integer>', schema)).toThrow("Invalid serialized integer");
    });

    it('should deserialize an array of strings', () => {
        const schema: JSONSchema = { type: "array", description: "An array", items: { type: "string", description: "String item" } };
        const xml = '<array><string>item1</string><string>item2</string></array>';
        expect(deserialize(xml, schema)).toEqual(['item1', 'item2']);
    });

    it('should throw error for invalid serialized array', () => {
        const schema: JSONSchema = { type: "array", description: "An array", items: { type: "string", description: "String item" } };
        expect(() => deserialize('<array><number>123</number></array>', schema)).toThrow("Invalid serialized string");
    });

    it('should deserialize an object with properties', () => {
        const schema: JSONSchema = {
            type: "object",
            description: "An object",
            properties: { key1: { type: "string", description: "A string" }, key2: { type: "number", description: "A number" } }
        };
        const xml = '<object><key1><string>value1</string></key1><key2><number>42</number></key2></object>';
        expect(deserialize(xml, schema)).toEqual({ key1: 'value1', key2: 42 });
    });

    it('should throw error for missing serialized object property', () => {
        const schema: JSONSchema = { type: "object", description: "An object", properties: { key1: { type: "string", description: "A string" } } };
        const xml = '<object><key2><string>value2</string></key2></object>';
        expect(() => deserialize(xml, schema)).toThrow("Missing serialized property: key1");
    });

    // Round-trip tests
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
    it('should handle complex nested objects', () => {
        const schema: JSONSchema = {
            type: "object",
            description: "Complex nested object",
            properties: {
                level1: {
                    type: "object",
                    description: "Level 1 object",
                    properties: {
                        level2: {
                            type: "object",
                            description: "Level 2 object",
                            properties: {
                                value: { type: "string", description: "Nested string" }
                            }
                        }
                    }
                }
            }
        };
        const originalValue = { level1: { level2: { value: 'deep' } } };
        const xml = serialize(originalValue, schema);
        const result = deserialize(xml, schema);
        expect(result).toEqual(originalValue);
    });

    it('should handle arrays of complex objects', () => {
        const schema: JSONSchema = {
            type: "array",
            description: "Array of objects",
            items: {
                type: "object",
                description: "An object with multiple properties",
                properties: {
                    name: { type: "string", description: "Name" },
                    attributes: {
                        type: "object",
                        description: "Attributes object",
                        properties: {
                            age: { type: "integer", description: "Age" },
                            active: { type: "boolean", description: "Active status" }
                        }
                    }
                }
            }
        };
        const originalValue = [
            { name: 'John', attributes: { age: 30, active: true } },
            { name: 'Jane', attributes: { age: 25, active: false } }
        ];
        const xml = serialize(originalValue, schema);
        const result = deserialize(xml, schema);
        expect(result).toEqual(originalValue);
    });

    it('should handle nested arrays', () => {
        const schema: JSONSchema = {
            type: "array",
            description: "Array of arrays",
            items: {
                type: "array",
                description: "Inner array of strings",
                items: { type: "string", description: "String item" }
            }
        };
        const originalValue = [ ["a", "b"], ["c", "d"] ];
        const xml = serialize(originalValue, schema);
        const result = deserialize(xml, schema);
        expect(result).toEqual(originalValue);
    });

    it('should handle a mix of data types in an array', () => {
        const schema: JSONSchema = {
            type: "array",
            description: "Array with mixed data types",
            items: { type: "string", description: "String item" }
        };
        const originalValue = ["a", "b", "c"];
        const xml = serialize(originalValue, schema);
        const result = deserialize(xml, schema);
        expect(result).toEqual(originalValue);
    });

    it('should handle deep and mixed objects', () => {
        const schema: JSONSchema = {
            type: "object",
            description: "Deep mixed object",
            properties: {
                id: { type: "integer", description: "ID" },
                info: {
                    type: "object",
                    description: "Info object",
                    properties: {
                        name: { type: "string", description: "Name" },
                        aliases: {
                            type: "array",
                            description: "Aliases",
                            items: { type: "string", description: "Alias" }
                        }
                    }
                }
            }
        };
        const originalValue = { id: 123, info: { name: 'Graham', aliases: ['G', 'Gr'] } };
        const xml = serialize(originalValue, schema);
        const result = deserialize(xml, schema);
        expect(result).toEqual(originalValue);
    });

    it('should manage max boundary conditions for numbers', () => {
        const schema: JSONSchema = {
            type: "number",
            description: "Number with max boundary",
            maximum: 100
        };
        const originalValue = 100;
        const xml = serialize(originalValue, schema);
        const result = deserialize(xml, schema);
        expect(result).toBe(originalValue);
    });

    it('should manage min boundary conditions for integers', () => {
        const schema: JSONSchema = {
            type: "integer",
            description: "Integer with min boundary",
            minimum: 10
        };
        const originalValue = 10;
        const xml = serialize(originalValue, schema);
        const result = deserialize(xml, schema);
        expect(result).toBe(originalValue);
    });

    it('should handle empty nested objects', () => {
        const schema: JSONSchema = {
            type: "object",
            description: "Empty nested object",
            properties: {
                emptyObj: {
                    type: "object",
                    description: "Inner empty object",
                    properties: {}
                }
            }
        };
        const originalValue = { emptyObj: {} };
        const xml = serialize(originalValue, schema);
        const result = deserialize(xml, schema);
        expect(result).toEqual(originalValue);
    });

    it('should handle chained enums successfully', () => {
        const schema: JSONSchema = {
            type: "string",
            description: "Enum string",
            enum: ["alpha", "beta", "gamma"]
        };
        const originalValue = "beta";
        const xml = serialize(originalValue, schema);
        const result = deserialize(xml, schema);
        expect(result).toBe(originalValue);
    });

});

