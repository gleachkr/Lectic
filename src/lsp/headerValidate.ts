// Non-throwing validators that mirror runtime checks and return
// structured issues with YAML-like paths for precise diagnostics.
import { isLLMProvider } from "../types/provider"

export type Issue = {
  code: string
  message: string
  path: (string | number)[]
  severity: "error" | "warning"
}

export function validateHeaderShape(spec: unknown): Issue[] {
  const issues: Issue[] = []
  if (spec === null || typeof spec !== "object") {
    // Let existing top-level diagnostic handle this case.
    return issues
  }

  const root: any = spec

  const validateInter = (raw: any, pathBase: (string | number)[]) => {
    // name
    if (!("name" in raw) || typeof raw.name !== "string") {
      issues.push({
        code: "interlocutor.name.missing",
        message:
          "An interlocutor is missing a name. The name needs to be a string.",
        path: [...pathBase, "name"],
        severity: "error"
      })
    }
    const nameVal = typeof raw?.name === "string" ? raw.name : "<unknown>"

    // prompt
    if (!("prompt" in raw) || typeof raw.prompt !== "string") {
      issues.push({
        code: "interlocutor.prompt.missing",
        message:
          `Interlocutor ${nameVal} needs a prompt. The prompt needs to be a string.`,
        path: [...pathBase, "prompt"],
        severity: "error"
      })
    }

    // model
    if ("model" in raw && typeof raw.model !== "string") {
      issues.push({
        code: "interlocutor.model.type",
        message: `The model type for ${nameVal} needs to be a string`,
        path: [...pathBase, "model"],
        severity: "error"
      })
    }

    // provider
    if ("provider" in raw && !isLLMProvider(raw.provider)) {
      issues.push({
        code: "interlocutor.provider.enum",
        message: `The provider for ${nameVal} wasn't recognized.`,
        path: [...pathBase, "provider"],
        severity: "error"
      })
    }

    // max_tokens
    if ("max_tokens" in raw && typeof raw.max_tokens !== "number") {
      issues.push({
        code: "interlocutor.max_tokens.type",
        message:
          `The max_tokens for ${nameVal} wasn't well-formed, it needs to be a number.`,
        path: [...pathBase, "max_tokens"],
        severity: "error"
      })
    }

    // max_tool_use
    if ("max_tool_use" in raw && typeof raw.max_tool_use !== "number") {
      issues.push({
        code: "interlocutor.max_tool_use.type",
        message:
          `The max_tool_use for ${nameVal} wasn't well-formed, it needs to be a number.`,
        path: [...pathBase, "max_tool_use"],
        severity: "error"
      })
    }

    // reminder
    if ("reminder" in raw && typeof raw.reminder !== "string") {
      issues.push({
        code: "interlocutor.reminder.type",
        message:
          `The reminder for ${nameVal} wasn't well-formed, it needs to be a string.`,
        path: [...pathBase, "reminder"],
        severity: "error"
      })
    }

    // nocache
    if ("nocache" in raw && typeof raw.nocache !== "boolean") {
      issues.push({
        code: "interlocutor.nocache.type",
        message:
          `The nocache option for ${nameVal} wasn't well-formed, it needs to be a boolean.`,
        path: [...pathBase, "nocache"],
        severity: "error"
      })
    }

    // temperature
    if ("temperature" in raw) {
      if (typeof raw.temperature !== "number") {
        issues.push({
          code: "interlocutor.temperature.type",
          message:
            `The temperature for ${nameVal} wasn't well-formed, it needs to be a number.`,
          path: [...pathBase, "temperature"],
          severity: "error"
        })
      } else if (raw.temperature > 1 || raw.temperature < 0) {
        issues.push({
          code: "interlocutor.temperature.range",
          message:
            `The temperature for ${nameVal} wasn't well-formed, it needs to between 1 and 0.`,
          path: [...pathBase, "temperature"],
          severity: "error"
        })
      }
    }

    // tools
    if ("tools" in raw) {
      if (!(typeof raw.tools === "object" && Array.isArray(raw.tools))) {
        issues.push({
          code: "interlocutor.tools.type",
          message: `The tools for ${nameVal} need to be given in an array.`,
          path: [...pathBase, "tools"],
          severity: "error"
        })
      } else if (!(raw.tools.every((t: any) => typeof t === "object"))) {
        issues.push({
          code: "interlocutor.tools.items",
          message:
            `One or more tools for ${nameVal} weren't properly specified`,
          path: [...pathBase, "tools"],
          severity: "error"
        })
      }
    }
  }

  if ("interlocutor" in root && root.interlocutor) {
    validateInter(root.interlocutor, ["interlocutor"])
  }
  if (Array.isArray(root?.interlocutors)) {
    root.interlocutors.forEach((it: any, i: number) =>
      validateInter(it, ["interlocutors", i])
    )
  }

  // macros
  if (Array.isArray(root?.macros)) {
    root.macros.forEach((m: any, i: number) => {
      if (!(m && typeof m === "object")) return
      if (!("name" in m) || typeof m.name !== "string") {
        issues.push({
          code: "macro.name.missing",
          message: `Macro needs to be given with a "name" field.`,
          path: ["macros", i, "name"],
          severity: "error"
        })
      }
      if (!("expansion" in m) || typeof m.expansion !== "string") {
        issues.push({
          code: "macro.expansion.missing",
          message: `Macro needs to be given with an "expansion" field.`,
          path: ["macros", i, "expansion"],
          severity: "error"
        })
      }
    })
  }

  // hooks
  if (Array.isArray(root?.hooks)) {
    root.hooks.forEach((h: any, i: number) => {
      if (!(h && typeof h === "object")) return
      if (!("on" in h)) {
        issues.push({
          code: "hook.on.missing",
          message: `Hook needs to be given with an "on" field.`,
          path: ["hooks", i, "on"],
          severity: "error"
        })
      } else if (typeof h.on !== "string" && !Array.isArray(h.on)) {
        issues.push({
          code: "hook.on.type",
          message:
            `The "on" field of a hook must be a string or array of strings.`,
          path: ["hooks", i, "on"],
          severity: "error"
        })
      } else {
        const allowed = ["user_message", "assistant_message", "error"]
        const ok = typeof h.on === "string"
          ? allowed.includes(h.on)
          : (h.on as any[]).every((x) => allowed.includes(x))
        if (!ok) {
          issues.push({
            code: "hook.on.value",
            message: `Hook "on" needs to be one of ${allowed.join(", ")}.`,
            path: ["hooks", i, "on"],
            severity: "error"
          })
        }
      }
      if (!("do" in h) || typeof h.do !== "string") {
        issues.push({
          code: "hook.do.missing",
          message: `Hook needs to be given with a "do" field.`,
          path: ["hooks", i, "do"],
          severity: "error"
        })
      }
    })
  }

  return issues
}
