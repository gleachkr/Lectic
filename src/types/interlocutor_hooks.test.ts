import { LecticHeader, validateLecticHeaderSpec } from './lectic';
import { getScopedHooks } from './backend';
import { expect, it, describe } from "bun:test";

describe('LecticHeader Hooks', () => {
  it('should allow hooks on an interlocutor', () => {
    const spec = {
      interlocutor: {
        name: 'Assistant',
        prompt: 'You are an assistant.',
        hooks: [
            { on: 'user_message', do: 'echo "hello"' }
        ]
      }
    };
    // Constructor allows it (it assumes valid input)
    const header = new LecticHeader(spec as any);
    expect(header.interlocutor.hooks).toBeDefined();
    expect(header.interlocutor.hooks).toHaveLength(1);
    expect(header.interlocutor.hooks![0].do).toBe('echo "hello"');

    // Validator allows it too
    expect(validateLecticHeaderSpec(spec)).toBeTrue();
  });

  it('inherits interlocutor env in global and scoped hooks', async () => {
    const spec = {
      hooks: [{
        name: 'global',
        on: 'user_message',
        do: 'printf "$PRIVATE_DB"',
        inline: true,
      }],
      interlocutor: {
        name: 'Assistant',
        prompt: 'p',
        env: { PRIVATE_DB: '/interlocutor.sqlite3' },
        hooks: [{
          name: 'scoped',
          on: 'user_message',
          do: 'printf "$PRIVATE_DB"',
          inline: true,
          env: { PRIVATE_DB: '/hook.sqlite3' },
        }],
      },
    };
    const header = new LecticHeader(spec as any);
    await header.initialize();
    const hooks = getScopedHooks({ header } as any);

    expect(hooks[0].env['PRIVATE_DB']).toBe('/interlocutor.sqlite3');
    expect(hooks[1].env['PRIVATE_DB']).toBe('/hook.sqlite3');
  });

  it('rejects non-string interlocutor env values', () => {
    const spec = {
      interlocutor: {
        name: 'Assistant',
        prompt: 'p',
        env: { PRIVATE_DB: 42 },
      },
    };

    expect(() => validateLecticHeaderSpec(spec as any)).toThrow(
      'The env for Assistant wasn\'t well-formed'
    );
  });

  it('should validate hook structure inside interlocutor', () => {
      const spec = {
        interlocutor: {
          name: 'Assistant',
          prompt: 'p',
          hooks: [
              { on: 'invalid_event', do: 'echo' } // Invalid event name
          ]
        }
      };
      // The validation inside validateInterlocutor returns a generic message when isHookSpecList fails
      expect(() => validateLecticHeaderSpec(spec)).toThrow("One or more hooks for Assistant weren't properly specified");
  });

  it('should fail if hooks is not an array', () => {
      const spec = {
        interlocutor: {
          name: 'Assistant',
          prompt: 'p',
          hooks: "not-an-array"
        }
      };
      expect(() => validateLecticHeaderSpec(spec)).toThrow('The hooks for Assistant need to be given in an array');
  });
});
