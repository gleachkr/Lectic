import { UserMessage, AssistantMessage } from './message';
import { Macro } from './macro';
import { serializeCall, ToolCallResults } from './tool';
import type { Interlocutor } from "./interlocutor"
import type { Tool } from './tool';
import { expect, it, describe } from "bun:test";
import { serializeInlineAttachment } from "./inlineAttachment";

describe('UserMessage', () => {
    describe('containedLinks', () => {
        it('should extract a simple markdown link', () => {
            const message = new UserMessage({ content: 'Check out this [link](https://example.com).' });
            const links = message.containedLinks();
            expect(links).toHaveLength(1);
            expect(links[0]).toEqual({ text: 'link', URI: 'https://example.com', title: undefined });
        });

        it('should extract a link with a title', () => {
            const message = new UserMessage({ content: 'See [this site](https://example.com "Cool Site").' });
            const links = message.containedLinks();
            expect(links).toHaveLength(1);
            expect(links[0]).toEqual({ text: 'this site', URI: 'https://example.com', title: 'Cool Site' });
        });

        it('should extract multiple links', () => {
            const message = new UserMessage({ content: '[One](https://one.com) and [Two](https://two.com).' });
            const links = message.containedLinks();
            expect(links).toHaveLength(2);
            expect(links[0].URI).toBe('https://one.com');
            expect(links[1].URI).toBe('https://two.com');
        });

        it('should extract image references (alt text + URL + title)', () => {
            const message = new UserMessage({ content: 'An image: ![alt text](https://example.com/a.png "Title")' });
            const links = message.containedLinks();
            expect(links).toHaveLength(1);
            expect(links[0]).toEqual({ text: 'alt text', URI: 'https://example.com/a.png', title: 'Title' });
        });

        it('should handle messages with no links', () => {
            const message = new UserMessage({ content: 'This is a plain message.' });
            const links = message.containedLinks();
            expect(links).toHaveLength(0);
        });
    });

    describe('containedDirectives', () => {
        it('should extract a simple directive', () => {
            const message = new UserMessage({ content: 'Execute this: :cmd[ls -l].' });
            const directives = message.containedDirectives();
            expect(directives).toHaveLength(1);
            expect(directives[0]).toEqual({ name: 'cmd', text: 'ls -l', attributes: {} });
        });

        it('should extract a directive with attributes', () => {
            const message = new UserMessage({ content: 'Run :cmd[cat file.txt]{lang="bash"}.' });
            const directives = message.containedDirectives();
            expect(directives).toHaveLength(1);
            expect(directives[0]).toEqual({ name: 'cmd', text: 'cat file.txt', attributes: { lang: 'bash' } });
        });

        it('should extract multiple directives', () => {
            const message = new UserMessage({ content: ':one[first] and :two[second].' });
            const directives = message.containedDirectives();
            expect(directives).toHaveLength(2);
            expect(directives[0].name).toBe('one');
            expect(directives[1].name).toBe('two');
        });

        it('should handle messages with no directives', () => {
            const message = new UserMessage({ content: 'This is a plain message.' });
            const directives = message.containedDirectives();
            expect(directives).toHaveLength(0);
        });
    });

    describe('expandMacros', () => {
        const macros = [
            new Macro({ name: 'greet', expansion: 'Hello, World!' }),
            new Macro({ name: 'bye', expansion: 'Goodbye!' })
        ];

        it('should expand a single macro (legacy form)', async () => {
            const message = new UserMessage({ content: 'A message with :greet[].' });
            await message.expandMacros(macros);
            expect(message.content).toBe('A message with Hello, World!.');
        });

        it('should expand a single macro (new form)', async () => {
            const message = new UserMessage({ content: 'A message with :greet[].' });
            await message.expandMacros(macros);
            expect(message.content).toBe('A message with Hello, World!.');
        });

        it('should expand multiple different macros', async () => {
            const message = new UserMessage({ content: ':greet[] and :bye[]' });
            await message.expandMacros(macros);
            expect(message.content).toBe('Hello, World! and Goodbye!');
        });

        it('should expand multiple instances of the same macro', async () => {
            const message = new UserMessage({ content: ':greet[], I say :greet[]!' });
            await message.expandMacros(macros);
            expect(message.content).toBe('Hello, World!, I say Hello, World!!');
        });

        it('should not change content if no macros are present', async () => {
            const message = new UserMessage({ content: 'This is a plain message.' });
            await message.expandMacros(macros);
            expect(message.content).toBe('This is a plain message.');
        });

        it('should not expand an undefined macro', async () => {
            const message = new UserMessage({
                content: 'A message with :unknown[] and :macro[greet].'
            });
            await message.expandMacros(macros);
            expect(message.content).toBe(
                'A message with :unknown[] and :macro[greet].'
            );
        });

        it('should not expand a macro in a code block', async () => {
            const message = new UserMessage({ content: 'A message with :greet[] `:greet[]`.' });
            await message.expandMacros(macros);
            expect(message.content).toBe('A message with Hello, World! `:greet[]`.');
        });

        it('should leave non-macro directives untouched during expansion', async () => {
            const message = new UserMessage({ content: 'Before :cmd[ls] and :greet[] after' });
            await message.expandMacros(macros);
            expect(message.content).toBe('Before :cmd[ls] and Hello, World! after');
        });

        it('trims final newline after macro expansion', async () => {
            const withNL = new Macro({ name: 'with_nl', expansion: 'X\n' });
            const noNL = new Macro({ name: 'no_nl', expansion: 'Y' });

            const msg1 = new UserMessage({ content: ':with_nl[]' });
            await msg1.expandMacros([withNL]);
            expect(msg1.content.endsWith('\n')).toBe(false);

            const msg2 = new UserMessage({ content: ':no_nl[]' });
            await msg2.expandMacros([noNL]);
            expect(msg2.content.endsWith('\n')).toBe(false);
        });

        it('passes directive attributes as env to exec command expansions', async () => {
            const envMacro = new Macro({
                name: 'env_cmd',
                // Run through a shell so $FOO gets expanded
                expansion: 'exec: bash -lc "printf %s $FOO"'
            });
            const message = new UserMessage({
                content: 'Value: :env_cmd[]{FOO="bar"}'
            });
            await message.expandMacros([envMacro]);
            expect(message.content).toBe('Value: bar');
        });

        it('passes directive args as ARG to exec expansions', async () => {
            const script = [
                '#!/usr/bin/env bash',
                'printf "%s" "$ARG"',
                ''
            ].join('\n');
            const macro = new Macro({
                name: 'arg_echo',
                expansion: `exec: ${script}`
            });
            const message = new UserMessage({
                content: 'Arg: :arg_echo[hello]'
            });
            await message.expandMacros([macro]);
            expect(message.content).toBe('Arg: hello');
        });

        it('ARG attribute overrides directive bracket args', async () => {
            const script = [
                '#!/usr/bin/env bash',
                'printf "%s" "$ARG"',
                ''
            ].join('\n');
            const macro = new Macro({
                name: 'arg_override',
                expansion: `exec: ${script}`
            });
            const message = new UserMessage({
                content: 'Arg: :arg_override[hello]{ARG="override"}'
            });
            await message.expandMacros([macro]);
            expect(message.content).toBe('Arg: override');
        });

        it('passes directive attributes as env to exec script expansions', async () => {
            const script = [
                '#!/usr/bin/env bash',
                'printf "%s" "$FOO"',
                ''
            ].join('\n');
            const envScriptMacro = new Macro({
                name: 'env_script',
                expansion: `exec: ${script}`
            });
            const message = new UserMessage({
                content: 'Script value: :env_script[]{FOO="baz"}'
            });
            await message.expandMacros([envScriptMacro]);
            expect(message.content).toBe('Script value: baz');
        });

        it('treats valueless attribute as empty env var for exec commands', async () => {
            const emptyMacro = new Macro({
                name: 'env_empty',
                expansion: 'exec: bash -lc "printf %s \"$EMPTY\""'
            });
            const message = new UserMessage({
                content: 'Empty: :env_empty[]{EMPTY}'
            });
            await message.expandMacros([emptyMacro]);
            expect(message.content).toBe('Empty: ');
        });

        it('marks empty attribute as set (not unset) and shows empty value', async () => {
            const script = [
                '#!/usr/bin/env bash',
                'if [ -z "${EMPTY+x}" ]; then',
                '  printf "unset"',
                'else',
                '  printf "set"',
                'fi',
                'printf ":%s" "$EMPTY"',
                ''
            ].join('\n');
            const macro = new Macro({
                name: 'env_empty_set',
                expansion: `exec: ${script}`
            });
            const message = new UserMessage({
                content: 'Status: :env_empty_set[]{EMPTY}'
            });
            await message.expandMacros([macro]);
            expect(message.content).toBe('Status: set:');
        });
    });
});

describe('AssistantMessage', () => {
    it('extracts leading inline attachments into the first interaction', async () => {
        const fake: Interlocutor = { name: 'A', prompt: '', registry: {} } as any;
        const a1 = serializeInlineAttachment({ kind: 'cmd', command: 'x', content: 'C1' })
        const a2 = serializeInlineAttachment({ kind: 'cmd', command: 'y', content: 'C2' })
        const content = `${a1}\n\n${a2}\n\nThen text.`
        const msg = new AssistantMessage({ content, interlocutor: fake })
        const { attachments, interactions } = msg.parseAssistantContent()
        expect(attachments.length).toBe(0)
        expect(interactions.length).toBe(1)
        expect(interactions[0].attachments.length).toBe(2)
        expect(interactions[0].attachments[0].command).toBe('x')
        expect(interactions[0].attachments[1].command).toBe('y')
        expect(interactions[0].text).toContain('Then text.')
    })

    it('extracts interleaved inline attachments', async () => {
        const fake: Interlocutor = { name: 'A', prompt: '', registry: {} } as any;
        const a1 = serializeInlineAttachment({ kind: 'cmd', command: 'x', content: 'C1' })
        const content = `Text1\n\n${a1}\n\nText2`
        const msg = new AssistantMessage({ content, interlocutor: fake })
        const { interactions } = msg.parseAssistantContent()
        
        expect(interactions.length).toBe(2)
        
        // Interaction 1: Text1
        expect(interactions[0].text).toContain('Text1')
        expect(interactions[0].attachments.length).toBe(0)
        
        // Interaction 2: Attachment + Text2
        expect(interactions[1].attachments.length).toBe(1)
        expect(interactions[1].attachments[0].command).toBe('x')
        expect(interactions[1].text).toContain('Text2')
    })

    it('should extract a tool call', async () => {
        const tool: Tool = {
            name: 'booleanTool',
            description: 'Tool that handles booleans',
            parameters: { confirmed: { type: 'boolean', description: 'Confirmation status' } },
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

        const content = `hello!\n\n${serialized}\n\ngoodbye!`

        const fakeInterlocutor = { registry: { booleanTool: tool }, name: 'A', prompt: '' } as unknown as Interlocutor

        const msg = new AssistantMessage({content, interlocutor: fakeInterlocutor})

        expect(msg.parseAssistantContent().interactions.map(i => i.calls.length)).toEqual([ 1, 0 ]);
    })

    it('should extract a tool call whose results contain line breaks', async () => {
        const tool: Tool = {
            name: 'booleanTool',
            description: 'Tool that handles booleans',
            parameters: { confirmed: { type: 'boolean', description: 'Confirmation status' } },
            call: async (_arg) => ToolCallResults('done\n\ndone\n\ndone\n\ndone'),
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

        const content = `hello!\n\n${serialized}\n\ngoodbye!`

        const fakeInterlocutor = { registry: { booleanTool: tool }, name: 'A', prompt: '' } as unknown as Interlocutor

        const msg = new AssistantMessage({content, interlocutor: fakeInterlocutor})

        expect(msg.parseAssistantContent().interactions.map(i => i.calls.length)).toEqual([ 1, 0 ]);
    })

    it('groups consecutive tool calls into a single interaction', async () => {
        const tool: Tool = {
            name: 'echo',
            description: 'echo tool',
            parameters: { s: { type: 'string', description: 'string' } },
            call: async (_arg) => ToolCallResults('x'),
            validateArguments: _ => null,
            required: [],
            hooks: []
        };
        const call1 = { name: 'echo', args: { s: 'a' }, results: ToolCallResults('ra') };
        const call2 = { name: 'echo', args: { s: 'b' }, results: ToolCallResults('rb') };
        const s1 = serializeCall(tool, call1);
        const s2 = serializeCall(tool, call2);
        const content = `prelude\n\n${s1}\n\n${s2}\n\ntrail`;
        const fake: Interlocutor = { name: 'A', prompt: '', registry: { echo: tool } } as any;
        const msg = new AssistantMessage({ content, interlocutor: fake });
        const interactions = msg.parseAssistantContent().interactions;
        expect(interactions.length).toBe(2);
        expect(interactions[0].calls.length).toBe(2);
        expect(interactions[1].calls.length).toBe(0);
        expect(interactions[0].text.includes('prelude')).toBe(true);
        expect(interactions[1].text.includes('trail')).toBe(true);
    });

    it('handles a leading tool call (empty text in first interaction)', async () => {
        const tool: Tool = {
            name: 'noop',
            description: 'noop',
            parameters: {},
            call: async (_arg) => ToolCallResults('done'),
            validateArguments: _ => null,
            required: [],
            hooks: []
        };
        const s = serializeCall(tool, { name: 'noop', args: {}, results: ToolCallResults('r')});
        const content = `${s}\n\nthen some text`;
        const fake: Interlocutor = { name: 'A', prompt: '', registry: { noop: tool } } as any;
        const msg = new AssistantMessage({ content, interlocutor: fake });
        const interactions = msg.parseAssistantContent().interactions;
        expect(interactions.length).toBe(2);
        expect(interactions[0].text).toBe("");
        expect(interactions[0].calls.length).toBe(1);
        expect(interactions[1].text).toContain('then some text');
        expect(interactions[1].calls.length).toBe(0);
    });

    it('returns a single text-only interaction when there are no tool calls', () => {
        const fake: Interlocutor = { name: 'A', prompt: '', registry: {} } as any;
        const content = 'just text\n\nmore text';
        const msg = new AssistantMessage({ content, interlocutor: fake });
        const interactions = msg.parseAssistantContent().interactions;
        expect(interactions.length).toBe(1);
        expect(interactions[0].calls.length).toBe(0);
        expect(interactions[0].text).toContain('just text');
    });

    it('parses id and is-error flags from serialized tool calls', () => {
        const tool: Tool = {
            name: 'sum',
            description: 'sum',
            parameters: { a: { type: 'number', description: 'a' }, b: { type: 'number', description: 'b' } },
            call: async (_arg) => ToolCallResults('3'),
            validateArguments: _ => null,
            required: [],
            hooks: []
        };
        const call = {
            name: 'sum',
            args: { a: 1, b: 2 },
            results: ToolCallResults('3'),
            id: 'abc-123',
            isError: true
        };
        const s = serializeCall(tool, call);
        const fake: Interlocutor = { name: 'A', prompt: '', registry: { sum: tool } } as any;
        const msg = new AssistantMessage({ content: s, interlocutor: fake });
        const interactions = msg.parseAssistantContent().interactions;
        expect(interactions.length).toBe(1);
        expect(interactions[0].calls.length).toBe(1);
        const parsed = interactions[0].calls[0];
        expect(parsed.id).toBe('abc-123');
        expect(parsed.isError).toBe(true);
    });

    it('parses tool calls even if the tool is missing from the registry', () => {
        const tool: Tool = {
            name: 'echo',
            description: 'echo',
            parameters: { s: { type: 'string', description: 's' } },
            call: async (_arg) => ToolCallResults('x'),
            validateArguments: _ => null,
            required: [],
            hooks: []
        };
        const s = serializeCall(tool, { name: 'echo', args: { s: 'hi' }, results: ToolCallResults('ok')});
        const fake: Interlocutor = { name: 'A', prompt: '', registry: {} } as any; // echo missing
        const msg = new AssistantMessage({ content: `before\n\n${s}\n\nafter`, interlocutor: fake });
        const interactions = msg.parseAssistantContent().interactions;
        expect(interactions.length).toBe(2);
        expect(interactions[0].calls.length).toBe(1);
        expect(interactions[0].calls[0].name).toBe('echo');
    });
});
