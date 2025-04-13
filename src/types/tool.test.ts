import { serializeCall, deserializeCall } from './tool';
import type { Tool } from './tool';
import { expect, it, describe } from "bun:test"

describe('Round-trip of serializeCall and deserializeCall', () => {
    it('should roundtrip a tool call with simple string arguments', () => {
        const tool: Tool = {
            name: 'stringTool',
            description: 'Tool that handles strings',
            parameters: { message: { type: 'string', description: 'A message' } },
            call: async (_arg) => 'success',
            register() { }
        };

        const call = {
            name: 'stringTool',
            args : { message: 'hello world' },
            result : 'success'
        }

        const serialized = serializeCall(tool, call);
        const deserialized = deserializeCall(tool, serialized);

        expect(deserialized).toEqual(call);
    });

    it('should roundtrip a tool call with boolean arguments', () => {
        const tool: Tool = {
            name: 'booleanTool',
            description: 'Tool that handles booleans',
            parameters: { confirmed: { type: 'boolean', description: 'Confirmation status' } },
            call: async (_arg) => 'done',
            register() { }
        };

        const call = {
            name: 'booleanTool',
            args : { confirmed: true },
            result : 'done'
        }

        const serialized = serializeCall(tool, call);
        const deserialized = deserializeCall(tool, serialized);

        expect(deserialized).toEqual(call);
    });

    it('should roundtrip a tool call with number arguments', () => {
        const tool: Tool = {
            name: 'numberTool',
            description: 'Tool that handles numbers',
            parameters: { amount: { type: 'number', description: 'An amount' } },
            call: async (_arg) => 'calculated',
            register() { }
        };

        const call = {
            name: 'numberTool',
            args: { amount: 42.5 },
            result: 'calculated'
        }

        const serialized = serializeCall(tool, call);
        const deserialized = deserializeCall(tool, serialized);

        expect(deserialized).toEqual(call);
    });

    it('should roundtrip a tool call with array arguments', () => {
        const tool: Tool = {
            name: 'arrayTool',
            description: 'Tool that handles arrays',
            parameters: {
                items: { type: 'array', description: 'A list of items', items: { type: 'string', description: 'Item' } }
            },
            call: async (_arg) => 'completed',
            register() { }
        };

        const call = {
            name: 'arrayTool',
            args : { items: ['item1', 'item2'] },
            result :'completed'
        }

        const serialized = serializeCall(tool, call);
        const deserialized = deserializeCall(tool, serialized);

        expect(deserialized).toEqual(call);
    });

    it('should roundtrip a tool call with nested object arguments', () => {
        const tool: Tool = {
            name: 'nestedObjectTool',
            description: 'Tool that handles nested objects',
            parameters: {
                settings: {
                    type: 'object',
                    description: 'Settings object',
                    properties: {
                        volume: { type: 'integer', description: 'Volume setting' },
                        balance: { type: 'integer', description: 'Balance setting' }
                    }
                }
            },
            call: async (_arg) => 'adjusted',
            register() { }
        };

        const call = {
            name: 'nestedObjectTool',
            args : { settings: { volume: 70, balance: 30 } },
            result : 'adjusted'
        }

        const serialized = serializeCall(tool, call);
        const deserialized = deserializeCall(tool, serialized);

        expect(deserialized).toEqual(call);
    });

    const mockTool: Tool = {
        name: 'mockTool',
        description: 'A mock tool',
        parameters: { param: { type: 'string', description: 'A parameter' } },
        call: async (_arg) => 'result',
        register() {}
    };

    it('should correctly handle a ToolCall with an id attribute', () => {
        const call = {
            name: 'mockTool',
            args: { param: 'value' },
            result: 'result',
            id: '12345'
        };
        const serialized = serializeCall(mockTool, call);
        const deserialized = deserializeCall(mockTool, serialized);
        expect(deserialized).toEqual(call);
    });

    it('should correctly handle a ToolCall with an isError attribute', () => {
        const call = {
            name: 'mockTool',
            args: { param: 'value' },
            result: 'result',
            isError: true
        };
        const serialized = serializeCall(mockTool, call);
        const deserialized = deserializeCall(mockTool, serialized);
        expect(deserialized).toEqual(call);
    });

    it('should correctly handle a ToolCall with both id and isError attributes', () => {
        const call = {
            name: 'mockTool',
            args: { param: 'value' },
            result: 'result',
            id: '67890',
            isError: false
        };
        const serialized = serializeCall(mockTool, call);
        const deserialized = deserializeCall(mockTool, serialized);
        expect(deserialized).toEqual(call);
    });

    it('should correctly handle a ToolCall without id and isError attributes', () => {
        const call = {
            name: 'mockTool',
            args: { param: 'value' },
            result: 'result'
        };
        const serialized = serializeCall(mockTool, call);
        const deserialized = deserializeCall(mockTool, serialized);
        expect(deserialized).toEqual(call);
    });
});
