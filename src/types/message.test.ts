import { UserMessage } from './message';
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
});

describe('AssistantMessage', () => {
    // We'll add tests for AssistantMessage later if needed.
    // For now, the focus is on UserMessage.
});
