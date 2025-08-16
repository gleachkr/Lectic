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
    });
});

describe('AssistantMessage', () => {
    // We'll add tests for AssistantMessage later if needed.
    // For now, the focus is on UserMessage.
});
