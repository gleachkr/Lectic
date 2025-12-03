import { LecticHeader, validateLecticHeaderSpec } from './lectic';
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
