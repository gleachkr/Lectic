import { LecticHeader } from './lectic';
import { ExecTool } from '../tools/exec';
import { SQLiteTool } from '../tools/sqlite';
import { ThinkTool } from '../tools/think';
import { ServeTool } from '../tools/serve';
import { AgentTool } from '../tools/agent';
import { expect, it, describe, mock } from "bun:test";

// Mock the file and exec loaders
mock.module('../utils/loader', () => ({
  loadFrom: async (spec: any) => {
    if (typeof spec === 'string' && spec.startsWith('file:')) {
      return `content from ${spec.slice(5)}`;
    }
    if (typeof spec === 'string' && spec.startsWith('exec:')) {
        return `output from ${spec.slice(5)}`;
    }
    return spec;
  },
}));


describe('LecticHeader', () => {
  it('should initialize with a single interlocutor', () => {
    const spec = {
      interlocutor: { name: 'Assistant', prompt: 'You are an assistant.' }
    };
    const header = new LecticHeader(spec);
    expect(header.interlocutor.name).toBe('Assistant');
    expect(header.interlocutors).toHaveLength(1);
  });

  it('should initialize with multiple interlocutors', () => {
    const spec = {
      interlocutors: [
        { name: 'Assistant', prompt: 'Prompt 1' },
        { name: 'Critic', prompt: 'Prompt 2' }
      ]
    };
    const header = new LecticHeader(spec as any);
    expect(header.interlocutor.name).toBe('Assistant');
    expect(header.interlocutors).toHaveLength(2);
  });

  it('should switch the main interlocutor', () => {
    const spec = {
        interlocutors: [
          { name: 'Assistant', prompt: 'Prompt 1' },
          { name: 'Critic', prompt: 'Prompt 2' }
        ]
      };
      const header = new LecticHeader(spec as any);
      header.setSpeaker('Critic');
      expect(header.interlocutor.name).toBe('Critic');
  });

  it('should throw an error when switching to a non-existent interlocutor', () => {
    const spec = {
        interlocutors: [
          { name: 'Assistant', prompt: 'Prompt 1' },
        ]
      };
      const header = new LecticHeader(spec as any);
      expect(() => header.setSpeaker('Ghost')).toThrow("There's not an interlocutor named Ghost");
  });

  describe('Tool Initialization', () => {
    it('should correctly initialize an ExecTool', async () => {
      const spec = {
        interlocutor: {
          name: 'Tester',
          prompt: 'Test prompt',
          tools: [{ exec: 'ls', name: 'lister' }]
        }
      };
      const header = new LecticHeader(spec);
      await header.initialize();
      const interlocutor = header.interlocutor;
      expect(interlocutor.registry?.['lister']).toBeInstanceOf(ExecTool);
    });

    it('should correctly initialize an SQLiteTool', async () => {
        const spec = {
          interlocutor: {
            name: 'Tester',
            prompt: 'Test prompt',
            tools: [{ sqlite: './db.sqlite', name: 'db' }]
          }
        };
        const header = new LecticHeader(spec);
        await header.initialize();
        const interlocutor = header.interlocutor;
        expect(interlocutor.registry?.['db']).toBeInstanceOf(SQLiteTool);
      });

    it('should correctly initialize a ThinkTool', async () => {
        const spec = {
          interlocutor: {
            name: 'Tester',
            prompt: 'Test prompt',
            tools: [{ think_about: 'the problem' }]
          }
        };
        const header = new LecticHeader(spec);
        await header.initialize();
        const interlocutor = header.interlocutor;
        // Default name for think tool is 'think'
        const thinkTool = Object.values(interlocutor.registry ?? {}).find(tool => tool instanceof ThinkTool)
        expect(thinkTool).toBeInstanceOf(ThinkTool);
    });

    it('should correctly initialize a ServeTool', async () => {
        const spec = {
          interlocutor: {
            name: 'Tester',
            prompt: 'Test prompt',
            tools: [{ serve_on_port: 8080, name: 'server' }]
          }
        };
        const header = new LecticHeader(spec);
        await header.initialize();
        const interlocutor = header.interlocutor;
        expect(interlocutor.registry?.['server']).toBeInstanceOf(ServeTool);
    });

    it('should correctly initialize an AgentTool', async () => {
        const spec = {
          interlocutors: [
            { name: 'Caller', prompt: 'p1', tools: [{ agent: 'Receiver', name: 'caller' }] },
            { name: 'Receiver', prompt: 'p2' }
          ]
        };
        const header = new LecticHeader(spec as any);
        await header.initialize();
        const interlocutor = header.interlocutors[0];
        expect(interlocutor.registry?.['caller']).toBeInstanceOf(AgentTool);
      });

    it('should throw an error for unrecognized tool specs', async () => {
        const spec = {
          interlocutor: {
            name: 'Tester',
            prompt: 'Test prompt',
            tools: [{ unsupported_tool: 'some_value' }]
          }
        };
        const header = new LecticHeader(spec);
        const test = async () => await header.initialize();
        expect(test).toThrow('The tool provided by {"unsupported_tool":"some_value"} wasn\'t recognized.');
    });

    it('should throw an error for duplicate tool names', async () => {
        const spec = {
          interlocutor: {
            name: 'Tester',
            prompt: 'Test prompt',
            tools: [
                { exec: 'ls', name: 'tool' },
                { exec: 'pwd', name: 'tool' }
            ]
          }
        };
        const header = new LecticHeader(spec);
        const test = async () => await header.initialize();
        expect(test).toThrow('the name tool is being used twice. Each tool needs a unique name');
    });

    it('should handle native tools without adding to registry', async () => {
        const spec = {
            interlocutor: {
              name: 'Tester',
              prompt: 'Test prompt',
              tools: [{ native: 'search' }]
            }
          };
          const header = new LecticHeader(spec);
          await header.initialize();
          const interlocutor = header.interlocutor;
          expect(interlocutor.registry).toEqual({});
    });
  });
});
