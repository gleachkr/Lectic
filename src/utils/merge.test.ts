import { mergeValues } from './merge';
import { expect, it, describe } from "bun:test";

describe('mergeValues', () => {
    it('should return the second value if they are not objects or arrays', () => {
        expect(mergeValues(1, 2)).toBe(2);
        expect(mergeValues('a', 'b')).toBe('b');
        expect(mergeValues(true, false)).toBe(false);
    });

    it('should return the base value if the second value is null or undefined', () => {
        expect(mergeValues(1, null)).toBe(1);
        expect(mergeValues('a', undefined)).toBe('a');
    });

    it('should merge two objects recursively', () => {
        const base: { a: number; b: { c: number } } = { a: 1, b: { c: 2 } };
        const apply: { b: { d: number }; e: number } = { b: { d: 3 }, e: 4 };
        const result = mergeValues(base as any, apply as any);
        expect(result).toEqual({ a: 1, b: { c: 2, d: 3 }, e: 4 });
    });

    it('should handle one object being null', () => {
        const base = { a: 1 };
        expect(mergeValues(base, null)).toEqual(base);
        expect(mergeValues(null, base)).toEqual(base);
    });

    it('should handle both objects being null', () => {
        expect(mergeValues(null, null)).toBe(null);
    });

    it('should concatenate arrays without named items', () => {
        const base = [1, 2];
        const apply = [3, 4];
        const result = mergeValues(base as any, apply as any);
        expect(result).toEqual([1, 2, 3, 4]);
    });

    it('should merge arrays with named items', () => {
        const base = [{ name: 'a', value: 1 }, { name: 'b', value: 2 }];
        const apply = [{ name: 'b', value: 3 }, { name: 'c', value: 4 }];
        const result = mergeValues(base as any, apply as any);
        expect(result).toEqual(expect.arrayContaining([
            { name: 'a', value: 1 },
            { name: 'b', value: 3 },
            { name: 'c', value: 4 }
        ]));
        expect(result.length).toBe(3)
    });

    it('should merge arrays with a mix of named and unnamed items', () => {
        const base = [{ name: 'a', value: 1 }, 2];
        const apply = [3, { name: 'a', value: 4 }];
        const result = mergeValues(base as any, apply as any);
        expect(result).toEqual(expect.arrayContaining([
            { name: 'a', value: 4 },
            2,
            3
        ]));
        expect(result.length).toBe(3)
    });

    it('should handle deeply nested structures', () => {
        const base = { a: { b: { c: { d: 1 } } }, x: [ { name: 'y', val: 'z' } ] };
        const apply = { a: { b: { e: 2 } }, x: [ { name: 'y', val: 'new_z' } ] };
        const result = mergeValues(base as any, apply as any);
        expect(result).toEqual({ a: { b: { c: { d: 1 }, e: 2 } }, x: [ { name: 'y', val: 'new_z' } ] });
    });

    it('should overwrite non-object with object', () => {
        const base = { a: 1 };
        const apply = { a: { b: 2 } };
        const result = mergeValues(base as any, apply as any);
        expect(result).toEqual({ a: { b: 2 } });
    });

    it('should overwrite object with non-object', () => {
        const base = { a: { b: 2 } };
        const apply = { a: 1 };
        const result = mergeValues(base as any, apply as any);
        expect(result).toEqual({ a: 1 });
    });

    it('should merge empty objects', () => {
        const base = {};
        const apply = { a: 1 };
        expect(mergeValues(base, apply)).toEqual({ a: 1 });
        expect(mergeValues(apply, base)).toEqual({ a: 1 });
    });

    it('should handle merging with empty arrays', () => {
        const base = [1, 2];
        const apply: any[] = [];
        expect(mergeValues(base, apply)).toEqual([1, 2]);
        expect(mergeValues(apply, base)).toEqual([1, 2]);
    });

    it('should handle merging arrays with null and undefined values', () => {
        const base: any[] = [1, null, 3];
        const apply: any[] = [undefined, 5];
        const result = mergeValues(base as any, apply as any);
        expect(result).toEqual([1, null, 3, undefined, 5]);
    });

    it('should handle duplicate named items in apply array, last one wins', () => {
        const base = [{ name: 'a', value: 1 }];
        const apply = [{ name: 'a', value: 2 }, { name: 'a', value: 3 }];
        const result = mergeValues(base as any, apply as any);
        expect(result).toEqual(expect.arrayContaining([{ name: 'a', value: 3 }]));
        expect(result.length).toBe(1);
    });

    it('should correctly merge a realistic Lectic header', () => {
        const base = {
            interlocutor: {
                name: 'BaseBot',
                prompt: 'Base prompt',
                tools: [
                    { name: 'shell', exec: 'bash' },
                    { name: 'python', exec: 'python3' }
                ]
            }
        };
        const apply = {
            interlocutor: {
                prompt: 'Override prompt',
                model: 'claude-3-opus-20240229',
                tools: [
                    { name: 'python', usage: 'For executing python code' },
                    { name: 'search', native: 'search' }
                ]
            }
        };
        const result = mergeValues(base as any, apply as any);
        expect(result).toEqual({
            interlocutor: {
                name: 'BaseBot',
                prompt: 'Override prompt',
                model: 'claude-3-opus-20240229',
                tools: expect.arrayContaining([
                    { name: 'shell', exec: 'bash' },
                    { name: 'python', exec: 'python3', usage: 'For executing python code' },
                    { name: 'search', native: 'search' }
                ])
            }
        });
        const tools = result.interlocutor.tools;
        expect(tools.length).toBe(3);
    });
});
