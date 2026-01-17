import { describe, expect, it } from "bun:test";
import { Lectic, LecticHeader, LecticBody } from "./lectic";
import { UserMessage } from "./message";

describe("Lectic Process Messages", () => {
  const baseSpec = {
    interlocutor: {
      name: "Assistant",
      prompt: "You are a helpful assistant.",
      model: "gpt-3.5-turbo",
    },
  };

  it("should process :merge_yaml directive and update header permanently", async () => {
    const header = new LecticHeader(baseSpec);
    const body = new LecticBody({
      messages: [
        new UserMessage({
          content: ':merge_yaml[{ interlocutor: { model: "gpt-4" } }]',
        }),
      ],
      raw: "",
    });
    const lectic = new Lectic({ header, body });

    await lectic.processMessages();

    expect(lectic.header.interlocutor.model).toBe("gpt-4");
  });

  it("should process :merge_yaml directive in history and update header", async () => {
    const header = new LecticHeader(baseSpec);
    const body = new LecticBody({
      messages: [
        new UserMessage({
          content: ':merge_yaml[{ interlocutor: { model: "gpt-4" } }]',
        }),
        new UserMessage({
          content: "Next message",
        }),
      ],
      raw: "",
    });
    const lectic = new Lectic({ header, body });

    await lectic.processMessages();

    expect(lectic.header.interlocutor.model).toBe("gpt-4");
  });

  it("should process :temp_merge_yaml directive in the last message", async () => {
    const header = new LecticHeader(baseSpec);
    const body = new LecticBody({
      messages: [
        new UserMessage({
          content: ':temp_merge_yaml[{ interlocutor: { model: "gpt-4" } }]',
        }),
      ],
      raw: "",
    });
    const lectic = new Lectic({ header, body });

    await lectic.processMessages();

    expect(lectic.header.interlocutor.model).toBe("gpt-4");
  });

  it("should NOT process :temp_merge_yaml directive if NOT in the last message", async () => {
    const header = new LecticHeader(baseSpec);
    const body = new LecticBody({
      messages: [
        new UserMessage({
          content: ':temp_merge_yaml[{ interlocutor: { model: "gpt-4" } }]',
        }),
        new UserMessage({
          content: "Next message",
        }),
      ],
      raw: "",
    });
    const lectic = new Lectic({ header, body });

    await lectic.processMessages();

    expect(lectic.header.interlocutor.model).toBe("gpt-3.5-turbo");
  });

  it("should process :ask directive and switch speaker", async () => {
    const spec = {
        interlocutors: [
            { name: "A", prompt: "A" },
            { name: "B", prompt: "B" }
        ]
    };
    const header = new LecticHeader(spec as any);
    const body = new LecticBody({
        messages: [
            new UserMessage({ content: ":ask[B]" })
        ],
        raw: ""
    });
    const lectic = new Lectic({ header, body });
    await lectic.processMessages();
    expect(lectic.header.interlocutor.name).toBe("B");
  });

  it("should process :aside directive in last message only", async () => {
    const spec = {
        interlocutors: [
            { name: "A", prompt: "A" },
            { name: "B", prompt: "B" }
        ]
    };
    // Case 1: aside in last message -> switch
    let header = new LecticHeader(spec as any);
    let body = new LecticBody({
        messages: [
            new UserMessage({ content: ":aside[B]" })
        ],
        raw: ""
    });
    let lectic = new Lectic({ header, body });
    await lectic.processMessages();
    expect(lectic.header.interlocutor.name).toBe("B");

    // Case 2: aside in history -> ignored (remains A)
    header = new LecticHeader(spec as any);
    body = new LecticBody({
        messages: [
            new UserMessage({ content: ":aside[B]" }),
            new UserMessage({ content: "follow up" })
        ],
        raw: ""
    });
    lectic = new Lectic({ header, body });
    await lectic.processMessages();
    expect(lectic.header.interlocutor.name).toBe("A");
  });

  it("should process :reset directive and truncate history", async () => {
      const header = new LecticHeader(baseSpec);
      const m1 = new UserMessage({ content: "1" });
      const m2 = new UserMessage({ content: ":reset[]" });
      const m3 = new UserMessage({ content: "3" });
      
      const body = new LecticBody({
          messages: [m1, m2, m3],
          raw: ""
      });
      const lectic = new Lectic({ header, body });
      
      await lectic.processMessages();
      
      expect(lectic.body.messages).toHaveLength(1);
      expect(lectic.body.messages[0].content).toBe("3");
  });

  it("should NOT execute merge_yaml emitted by a post macro", async () => {
    const header = new LecticHeader({
      ...baseSpec,
      macros: [
        {
          name: "evil",
          expansion: ':merge_yaml[{ interlocutor: { model: "gpt-4" } }]',
        },
      ],
    } as any)

    const body = new LecticBody({
      messages: [new UserMessage({ content: ":evil[]" })],
      raw: "",
    })

    const lectic = new Lectic({ header, body })

    await lectic.processMessages()

    expect(lectic.header.interlocutor.model).toBe("gpt-3.5-turbo")
  })

  it("should execute merge_yaml emitted by a pre macro", async () => {
    const header = new LecticHeader({
      ...baseSpec,
      macros: [
        {
          name: "trusted",
          pre: ':merge_yaml[{ interlocutor: { model: "gpt-4" } }]',
        },
      ],
    } as any)

    const body = new LecticBody({
      messages: [new UserMessage({ content: ":trusted[]" })],
      raw: "",
    })

    const lectic = new Lectic({ header, body })

    await lectic.processMessages()

    expect(lectic.header.interlocutor.model).toBe("gpt-4")
  })
});
