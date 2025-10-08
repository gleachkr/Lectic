// Centralized diagnostic and validation messages used by runtime
// validators and the LSP diagnostics pass. Keep text identical so
// tests and UX remain consistent.

export const Messages = {
  // Interlocutor
  interlocutor: {
    nameMissing: () =>
      "An interlocutor is missing a name. The name needs to be a string.",
    promptMissing: (name: string) =>
      `Interlocutor ${name} needs a prompt. The prompt needs to be a string.`,
    modelType: (name: string) =>
      `The model type for ${name} needs to be a string`,
    providerEnum: (name: string) =>
      `The provider for ${name} wasn't recognized.`,
    maxTokensType: (name: string) =>
      `The max_tokens for ${name} wasn't well-formed, it needs to be a number.`,
    maxToolUseType: (name: string) =>
      `The max_tool_use for ${name} wasn't well-formed, it needs to be a number.`,
    reminderType: (name: string) =>
      `The reminder for ${name} wasn't well-formed, it needs to be a string.`,
    nocacheType: (name: string) =>
      `The nocache option for ${name} wasn't well-formed, it needs to be a boolean.`,
    temperatureType: (name: string) =>
      `The temperature for ${name} wasn't well-formed, it needs to be a number.`,
    temperatureRange: (name: string) =>
      `The temperature for ${name} wasn't well-formed, it needs to between 1 and 0.`,
    toolsType: (name: string) =>
      `The tools for ${name} need to be given in an array.`,
    toolsItems: (name: string) =>
      `One or more tools for ${name} weren't properly specified`,
    // Broader constructor guard messages (runtime-only)
    baseNeedsNamePrompt: (raw: unknown) =>
      `Interlocutor needs to be given with at least name and prompt fields. Got ${raw} instead.`,
    baseNull: () => `Something went wrong, got null for interlocutor`,
  },

  // Macro
  macro: {
    nameMissing: () => `Macro needs to be given with a "name" field.`,
    expansionMissing: () =>
      `Macro needs to be given with an "expansion" field.`,
    baseNeedsNameExpansion: (raw: unknown) =>
      `Macro needs to be given with at least "name" and "expansion" fields. Got ${raw} instead.`,
    baseNull: () => `Something went wrong, got null for macro`,
  },

  // Hook
  hook: {
    onMissing: () => `Hook needs to be given with an "on" field.`,
    onType: () =>
      `The "on" field of a hook must be a string or array of strings.`,
    onValue: (allowed: string[]) =>
      `Hook "on" needs to be one of ${allowed.join(", ")}.`,
    doMissing: () => `Hook needs to be given with a "do" field.`,
    baseNeedsOnDo: (raw: unknown) =>
      `Hook needs to be given with at least "on" and "do" fields. Got ${raw} instead.`,
    baseNull: () => `Something went wrong, got null for hook`,
  }
} as const
