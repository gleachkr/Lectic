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
    nocacheType: (name: string) =>
      `The nocache option for ${name} wasn't well-formed, it needs to be a boolean.`,
    temperatureType: (name: string) =>
      `The temperature for ${name} wasn't well-formed, it needs to be a number.`,
    temperatureRange: (name: string) =>
      `The temperature for ${name} wasn't well-formed, it needs to between 1 and 0.`,
    thinkingBudgetType: (name: string) =>
      `The thinking budget for ${name} wasn't well-formed, it needs to be a whole number.`,
    thinkingEffortType: (name: string) =>
      `The thinking effort for ${name} wasn't well-formed, it needs to be one of 'none', 'low', 'medium' or 'high'.`,
    sandboxType: (name: string) =>
      `The sandbox for ${name} wasn't well-formed, it needs to be a string.`,
    toolsType: (name: string) =>
      `The tools for ${name} need to be given in an array.`,
    toolsItems: (name: string) =>
      `One or more tools for ${name} weren't properly specified`,
    hooksType: (name: string) =>
      `The hooks for ${name} need to be given in an array.`,
    hooksItems: (name: string) =>
      `One or more hooks for ${name} weren't properly specified`,
    unknownField: (name: string, field: string) =>
      `Unknown property "${field}" on interlocutor ${name}.`,
    // Broader constructor guard messages (runtime-only)
    baseNeedsNamePrompt: (raw: unknown) =>
      `Interlocutor needs to be given with at least name and prompt fields. Got ${raw} instead.`,
    baseNull: () => `Something went wrong, got null for interlocutor`,
  },

  // Macro
  macro: {
    nameMissing: () => `Macro needs to be given with a "name" field.`,
    expansionMissing: () =>
      `Macro needs to be given with an "expansion", "pre", or "post" field.`,
    envType: () => `The "env" field of a macro must be an object.`,
    baseNeedsNameExpansion: (raw: unknown) =>
      `Macro needs to be given with "name" and at least one of "expansion", "pre", or "post". Got ${raw} instead.`,
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
    envType: () => `The "env" field of a hook must be an object.`,
    nameType: () => `The "name" field of a hook must be a string.`,
    baseNeedsOnDo: (raw: unknown) =>
      `Hook needs to be given with at least "on" and "do" fields. Got ${raw} instead.`,
    baseNull: () => `Something went wrong, got null for hook`,
  },

  // Bundle
  kit: {
    nameMissing: () => `Kit needs to be given with a "name" field.`,
    toolsMissing: (name: string) =>
      `The kit ${name} needs a tools field.`,
    toolsType: (name: string) =>
      `The tools field of kit ${name} needs to be an array.`,
    toolsItems: (name: string) =>
      `One or more tools in kit ${name} weren't properly specified`,
    baseNeedsNameTools: (raw: unknown) =>
      `Kit needs to be given with at least "name" and "tools" fields. Got ${raw} instead.`,
    baseNull: () => `Something went wrong, got null for kit`,
    unknownReference: (kit: string) =>
      `Unknown kit reference: ${kit}`,
    cycle: (kit: string) =>
      `Kit expansion cycle detected at ${kit}`
  },

  // Header
  header: {
    baseNull: () => `Header cannot be null.`,
    baseType: () => `Header must be an object.`,
    missingInterlocutor: () => `Header must have either an 'interlocutor' or 'interlocutors' field.`,
    interlocutorsType: () => `'interlocutors' must be an array.`,
    interlocutorsEmpty: () => `'interlocutors' array cannot be empty.`,
    macrosType: () => `'macros' must be an array.`,
    hooksType: () => `'hooks' must be an array.`,
    kitsType: () => `'kits' must be an array.`
  }
} as const
