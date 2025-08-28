import { UserMessage } from './message';
import { Macro } from './macro';
import { expect, it, describe } from "bun:test";

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

        it('should expand a single macro', async () => {
            const message = new UserMessage({ content: 'A message with :macro[greet].' });
            await message.expandMacros(macros);
            expect(message.content).toBe('A message with Hello, World!.');
        });

        it('should expand multiple different macros', async () => {
            const message = new UserMessage({ content: ':macro[greet] and :macro[bye]' });
            await message.expandMacros(macros);
            expect(message.content).toBe('Hello, World! and Goodbye!');
        });

        it('should expand multiple instances of the same macro', async () => {
            const message = new UserMessage({ content: ':macro[greet], I say :macro[greet]!' });
            await message.expandMacros(macros);
            expect(message.content).toBe('Hello, World!, I say Hello, World!!');
        });

        it('should not change content if no macros are present', async () => {
            const message = new UserMessage({ content: 'This is a plain message.' });
            await message.expandMacros(macros);
            expect(message.content).toBe('This is a plain message.');
        });

        it('should not expand an undefined macro', async () => {
            const message = new UserMessage({ content: 'A message with :macro[unknown].' });
            await message.expandMacros(macros);
            expect(message.content).toBe('A message with :macro[unknown].');
        });

        it('should not expand a macro in a code block', async () => {
            const message = new UserMessage({ content: 'A message with :macro[greet] `:macro[greet]`.' });
            await message.expandMacros(macros);
            expect(message.content).toBe('A message with Hello, World! `:macro[greet]`.');
        });

        it('should leave non-macro directives untouched during expansion', async () => {
            const message = new UserMessage({ content: 'Before :cmd[ls] and :macro[greet] after' });
            await message.expandMacros(macros);
            expect(message.content).toBe('Before :cmd[ls] and Hello, World! after');
        });

        it('trims final newline after macro expansion', async () => {
            const withNL = new Macro({ name: 'with_nl', expansion: 'X\n' });
            const noNL = new Macro({ name: 'no_nl', expansion: 'Y' });

            const msg1 = new UserMessage({ content: ':macro[with_nl]' });
            await msg1.expandMacros([withNL]);
            expect(msg1.content.endsWith('\n')).toBe(false);

            const msg2 = new UserMessage({ content: ':macro[no_nl]' });
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
                content: 'Value: :macro[env_cmd]{FOO="bar"}'
            });
            await message.expandMacros([envMacro]);
            expect(message.content).toBe('Value: bar');
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
                content: 'Script value: :macro[env_script]{FOO="baz"}'
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
                content: 'Empty: :macro[env_empty]{EMPTY}'
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
                content: 'Status: :macro[env_empty_set]{EMPTY}'
            });
            await message.expandMacros([macro]);
            expect(message.content).toBe('Status: set:');
        });
    });
});

describe('AssistantMessage', () => {
    // We'll add tests for AssistantMessage later if needed.
    // For now, the focus is on UserMessage.
});
