import { expect, it, describe } from "bun:test";
import { AnthropicBackend } from "./anthropic";
import { OpenAIResponsesBackend } from "./openai-responses";
import { GeminiBackend } from "./gemini";
import { AssistantMessage, UserMessage } from "../types/message";
import { LLMProvider } from "../types/provider";
import { serializeThoughtBlock } from "../types/thought";
import { serializeInlineAttachment } from "../types/inlineAttachment";
import { serializeCall, ToolCallResults, type Tool } from "../types/tool";

describe("Thought provider matching", () => {
  const fakeLectic = {
    header: {
      interlocutor: {
        name: "Assistant",
        prompt: "system prompt",
      },
    },
  } as any;

  it("AnthropicBackend should skip non-anthropic thought blocks", async () => {
    const backend = new AnthropicBackend();
    const thought = serializeThoughtBlock({
      provider: "openai",
      content: ["reasoning"],
    });
    const msg = new AssistantMessage({
      content: thought,
      interlocutor: fakeLectic.header.interlocutor,
    });

    // @ts-expect-error - accessing protected method for testing
    const { messages } = await backend.handleMessage(msg, fakeLectic);

    // The message should be empty or not contain thought parts
    // AnthropicBackend handles messages by interactions.
    // results.push({ role: "assistant", content: modelParts })
    expect(messages).toHaveLength(0);
  });

  it("AnthropicBackend should include anthropic thought blocks", async () => {
    const backend = new AnthropicBackend();
    const thought = serializeThoughtBlock({
      provider: "anthropic",
      content: ["thinking"],
      opaque: { signature: "sig" }
    });
    const msg = new AssistantMessage({
      content: thought,
      interlocutor: fakeLectic.header.interlocutor,
    });

    // @ts-expect-error - accessing protected method for testing
    const { messages } = await backend.handleMessage(msg, fakeLectic);
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toContainEqual({
      type: "thinking",
      thinking: "thinking",
      signature: "sig"
    });
  });

  it("OpenAIResponsesBackend should skip non-openai thought blocks", async () => {
    const backend = new OpenAIResponsesBackend({
      apiKey: "OPENAI_API_KEY",
      provider: LLMProvider.OpenAIResponses,
      defaultModel: "gpt-4",
    });
    const thought = serializeThoughtBlock({
      provider: "anthropic",
      content: ["thinking"],
    });
    const msg = new AssistantMessage({
      content: thought,
      interlocutor: fakeLectic.header.interlocutor,
    });

    // @ts-expect-error - accessing protected method for testing
    const { messages } = await backend.handleMessage(msg, fakeLectic);
    expect(messages).toHaveLength(0);
  });

  it("OpenAIResponsesBackend should strip comments from user messages", async () => {
    const backend = new OpenAIResponsesBackend({
      apiKey: "OPENAI_API_KEY",
      provider: LLMProvider.OpenAIResponses,
      defaultModel: "gpt-4",
    });
    const msg = new UserMessage({
      content: "Alpha <!-- hidden --> Beta",
    });

    // @ts-expect-error - accessing protected method for testing
    const { messages } = await backend.handleMessage(msg, fakeLectic);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toEqual({
      role: "user",
      content: [{ type: "input_text", text: "Alpha  Beta" }],
    });
  });

  it("OpenAIResponsesBackend should include openai thought blocks", async () => {
    const backend = new OpenAIResponsesBackend({
      apiKey: "OPENAI_API_KEY",
      provider: LLMProvider.OpenAIResponses,
      defaultModel: "gpt-4",
    });
    const thought = serializeThoughtBlock({
      provider: "openai",
      content: ["reasoning"],
      status: "completed"
    });
    const msg = new AssistantMessage({
      content: thought,
      interlocutor: fakeLectic.header.interlocutor,
    });

    // @ts-expect-error - accessing protected method for testing
    const { messages } = await backend.handleMessage(msg, fakeLectic);
    expect(messages).toHaveLength(1);
    expect(messages[0].type).toBe("reasoning");
  });

  it("GeminiBackend should keep only prose in wrapped assistant text", async () => {
    const backend = new GeminiBackend();
    const tool: Tool = {
      name: "echo",
      description: "echo tool",
      parameters: {
        s: { type: "string", description: "text" },
      },
      required: [],
      kind: "mock",
      hooks: [],
      call: async (_args) => ToolCallResults("ok"),
      validateArguments: _ => null,
    };
    const attachment = serializeInlineAttachment({
      kind: "attach",
      command: "echo context",
      content: "attached context",
    });
    const thought = serializeThoughtBlock({
      provider: "openai",
      content: ["private reasoning"],
    });
    const call = serializeCall(tool, {
      name: "echo",
      args: { s: "hi" },
      results: ToolCallResults("done"),
    });
    const msg = new AssistantMessage({
      content: [
        "visible <!-- hidden --> text",
        "",
        attachment,
        "",
        thought,
        "",
        call,
        "",
        "after",
      ].join("\n"),
      interlocutor: {
        name: "Other",
        prompt: "",
        registry: { echo: tool },
      } as any,
    });

    // @ts-expect-error - accessing protected method for testing
    const { messages } = await backend.handleMessage(msg, fakeLectic);
    expect(messages).toHaveLength(1);
    expect(messages[0].parts).toEqual([
      {
        text:
          '<speaker name="Other">visible <!-- hidden --> text\n\n' +
          'after</speaker>'
      },
    ]);
  });

  it("GeminiBackend should skip non-gemini thought blocks", async () => {
    const backend = new GeminiBackend();
    const thought = serializeThoughtBlock({
      provider: "anthropic",
      content: ["thinking"],
    });
    const msg = new AssistantMessage({
      content: thought,
      interlocutor: fakeLectic.header.interlocutor,
    });

    // @ts-expect-error - accessing protected method for testing
    const { messages } = await backend.handleMessage(msg, fakeLectic);
    expect(messages).toHaveLength(1);
    expect(messages[0].parts).toHaveLength(0);
  });

  it("GeminiBackend should include gemini thought blocks", async () => {
    const backend = new GeminiBackend();
    const thought = serializeThoughtBlock({
      provider: "gemini",
      content: ["thinking"],
    });
    const msg = new AssistantMessage({
      content: thought,
      interlocutor: fakeLectic.header.interlocutor,
    });

    // @ts-expect-error - accessing protected method for testing
    const { messages } = await backend.handleMessage(msg, fakeLectic);
    expect(messages).toHaveLength(1);
    expect(messages[0].parts).toContainEqual({
      thought: true,
      text: "thinking",
    });
  });
});
