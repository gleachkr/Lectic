import { serializeCall, deserializeCall, ToolCallResults } from './tool';
import type { Tool } from './tool';
import { expect, it, describe } from "bun:test"

describe('Round-trip of serializeCall and deserializeCall', () => {
    it('should roundtrip a tool call with simple string arguments', () => {
        const tool: Tool = {
            name: 'stringTool',
            description: 'Tool that handles strings',
            parameters: { message: { type: 'string', description: 'A message' } },
            kind: 'mock',
            call: async (_arg) => ToolCallResults('success'),
            validateArguments: _ => null,
            required: [],
            hooks: []
        }

        const call = {
            name: 'stringTool',
            args : { message: 'hello world' },
            results : ToolCallResults('success')
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
            kind: 'mock',
            call: async (_arg) => ToolCallResults('done'),
            validateArguments: _ => null,
            required: [],
            hooks: []
        };

        const call = {
            name: 'booleanTool',
            args : { confirmed: true },
            results : ToolCallResults('done')
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
            kind: 'mock',
            call: async (_arg) => ToolCallResults('calculated'),
            validateArguments: _ => null,
            required: [],
            hooks: []
        };

        const call = {
            name: 'numberTool',
            args: { amount: 42.5 },
            results: ToolCallResults('calculated')
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
            kind: 'mock',
            call: async (_arg) => ToolCallResults('completed'),
            validateArguments: _ => null,
            required: [],
            hooks: []
        };

        const call = {
            name: 'arrayTool',
            args : { items: ['item1', 'item2'] },
            results : ToolCallResults('completed')
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
            kind: 'mock',
            call: async (_arg) => ToolCallResults('adjusted'),
            validateArguments: _ => null,
            required: [],
            hooks: []
        };

        const call = {
            name: 'nestedObjectTool',
            args : { settings: { volume: 70, balance: 30 } },
            results : ToolCallResults('adjusted')
        }

        const serialized = serializeCall(tool, call);
        const deserialized = deserializeCall(tool, serialized);

        expect(deserialized).toEqual(call);
    });

    const mockTool: Tool = {
        name: 'mockTool',
        description: 'A mock tool',
        parameters: { param: { type: 'string', description: 'A parameter' } },
        kind: 'mock',
        call: async (_arg) => ToolCallResults('result'),
        validateArguments: _ => null,
        required: [],
        hooks: []
    };

    it('should correctly handle a ToolCall with an id attribute', () => {
        const call = {
            name: 'mockTool',
            args: { param: 'value' },
            results: ToolCallResults('result'),
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
            results: ToolCallResults('result'),
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
            results: ToolCallResults('result'),
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
            results: ToolCallResults('result')
        };
        const serialized = serializeCall(mockTool, call);
        const deserialized = deserializeCall(mockTool, serialized);
        expect(deserialized).toEqual(call);
    });
});

describe('Result escaping round-trip edge cases', () => {
    const tool: Tool = {
        name: 'edgeTool',
        description: 'Tool for edge cases',
        parameters: { },
        kind: 'mock',
        call: async (_arg) => ToolCallResults('ok'),
        validateArguments: _ => null,
        required: [],
        hooks: []
    };

    const cases: string[] = [
        // simple special characters previously escaped
        '& < > " \' : ` _ *',
        // looks like closing tag
        'foo </tool-call> bar',
        // already neutralized sequence present
        '<│ already here and < also here',
        // lines starting with the prefix marker
        '┆leading',
        'line1\n┆line2',
        '┆first\nsecond',
        // multiple blank lines and mixes
        'a\n\n\n b\n',
        // mixture of everything
        'A<tool> B</tool-call> C\n┆start\n<│bar\n\nEND&',
    ];

    for (const [i, content] of cases.entries()) {
        it(`roundtrips result content case #${i+1}`, () => {
            const call = {
                name: 'edgeTool',
                args: { },
                results: ToolCallResults(content)
            };
            const serialized = serializeCall(tool, call);
            const deserialized = deserializeCall(tool, serialized);
            expect(deserialized).toEqual(call);
        });
    }

    it('roundtrips literal "<│" and lines beginning with "┆" after newline', () => {
        const content = 'x<│y\na\n┆b\nc';
        const call = {
            name: 'edgeTool',
            args: { },
            results: ToolCallResults(content)
        };
        const serialized = serializeCall(tool, call);
        const deserialized = deserializeCall(tool, serialized);
        expect(deserialized).toEqual(call);
    });
});
