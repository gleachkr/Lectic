// Non-throwing validators that mirror runtime checks and return
// structured issues with YAML-like paths for precise diagnostics.
import { isLLMProvider } from "../types/provider"
import { Messages } from "../constants/messages"
import { isObjectRecord } from "../types/guards"

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

  const root = spec as Record<string, unknown>

  const validateInter = (raw: Record<string, unknown>, pathBase: (string | number)[]) => {
    // name
    if (!("name" in raw) || typeof raw["name"] !== "string") {
      issues.push({
        code: "interlocutor.name.missing",
        message: Messages.interlocutor.nameMissing(),
        path: [...pathBase, "name"],
        severity: "error"
      })
    }
    const nameVal = typeof raw?.["name"] === "string" ? raw["name"] : "<unknown>"

    // prompt
    if (!("prompt" in raw) || typeof raw["prompt"] !== "string") {
      issues.push({
        code: "interlocutor.prompt.missing",
        message: Messages.interlocutor.promptMissing(nameVal),
        path: [...pathBase, "prompt"],
        severity: "error"
      })
    }

    // model
    if ("model" in raw && typeof raw["model"] !== "string") {
      issues.push({
        code: "interlocutor.model.type",
        message: Messages.interlocutor.modelType(nameVal),
        path: [...pathBase, "model"],
        severity: "error"
      })
    }

    // provider
    if ("provider" in raw && !isLLMProvider(raw["provider"])) {
      issues.push({
        code: "interlocutor.provider.enum",
        message: Messages.interlocutor.providerEnum(nameVal),
        path: [...pathBase, "provider"],
        severity: "error"
      })
    }

    // max_tokens
    if ("max_tokens" in raw && typeof raw["max_tokens"] !== "number") {
      issues.push({
        code: "interlocutor.max_tokens.type",
        message: Messages.interlocutor.maxTokensType(nameVal),
        path: [...pathBase, "max_tokens"],
        severity: "error"
      })
    }

    // max_tool_use
    if ("max_tool_use" in raw && typeof raw["max_tool_use"] !== "number") {
      issues.push({
        code: "interlocutor.max_tool_use.type",
        message: Messages.interlocutor.maxToolUseType(nameVal),
        path: [...pathBase, "max_tool_use"],
        severity: "error"
      })
    }

    // reminder
    if ("reminder" in raw && typeof raw["reminder"] !== "string") {
      issues.push({
        code: "interlocutor.reminder.type",
        message: Messages.interlocutor.reminderType(nameVal),
        path: [...pathBase, "reminder"],
        severity: "error"
      })
    }

    // nocache
    if ("nocache" in raw && typeof raw["nocache"] !== "boolean") {
      issues.push({
        code: "interlocutor.nocache.type",
        message: Messages.interlocutor.nocacheType(nameVal),
        path: [...pathBase, "nocache"],
        severity: "error"
      })
    }

    // temperature
    if ("temperature" in raw) {
      if (typeof raw["temperature"] !== "number") {
        issues.push({
          code: "interlocutor.temperature.type",
          message: Messages.interlocutor.temperatureType(nameVal),
          path: [...pathBase, "temperature"],
          severity: "error"
        })
      } else if (raw["temperature"] > 1 || raw["temperature"] < 0) {
        issues.push({
          code: "interlocutor.temperature.range",
          message: Messages.interlocutor.temperatureRange(nameVal),
          path: [...pathBase, "temperature"],
          severity: "error"
        })
      }
    }

    // tools
    if ("tools" in raw) {
      const tools = raw["tools"] as unknown
      if (!(Array.isArray(tools))) {
        issues.push({
          code: "interlocutor.tools.type",
          message: Messages.interlocutor.toolsType(nameVal),
          path: [...pathBase, "tools"],
          severity: "error"
        })
      } else if (!tools.every((t) => isObjectRecord(t))) {
        issues.push({
          code: "interlocutor.tools.items",
          message: Messages.interlocutor.toolsItems(nameVal),
          path: [...pathBase, "tools"],
          severity: "error"
        })
      }
    }
  }

  if ("interlocutor" in root && root["interlocutor"]) {
    validateInter(root["interlocutor"] as Record<string, unknown>, ["interlocutor"])
  }
  const inters = root?.["interlocutors"] as unknown
  if (Array.isArray(inters)) {
    inters.forEach((it, i: number) => {
      if (isObjectRecord(it)) validateInter(it, ["interlocutors", i])
    })
  }

  // macros
  const macros = root?.["macros"] as unknown
  if (Array.isArray(macros)) {
    macros.forEach((m, i: number) => {
      if (!isObjectRecord(m)) return
      if (!("name" in m) || typeof m["name"] !== "string") {
        issues.push({
          code: "macro.name.missing",
          message: Messages.macro.nameMissing(),
          path: ["macros", i, "name"],
          severity: "error"
        })
      }
      if (!("expansion" in m) || typeof m["expansion"] !== "string") {
        issues.push({
          code: "macro.expansion.missing",
          message: Messages.macro.expansionMissing(),
          path: ["macros", i, "expansion"],
          severity: "error"
        })
      }
    })
  }

  // bundles
  const bundles = root?.["bundles"] as unknown
  if (Array.isArray(bundles)) {
    bundles.forEach((b, i: number) => {
      if (!isObjectRecord(b)) return
      if (!("name" in b) || typeof b["name"] !== "string") {
        issues.push({
          code: "bundle.name.missing",
          message: Messages.bundle.nameMissing(),
          path: ["bundles", i, "name"],
          severity: "error"
        })
      }
      const nameVal = typeof b?.["name"] === "string" ? b["name"] : "<unknown>"
      if (!("tools" in b)) {
        issues.push({
          code: "bundle.tools.missing",
          message: Messages.bundle.toolsMissing(nameVal),
          path: ["bundles", i, "tools"],
          severity: "error"
        })
      } else if (!Array.isArray(b["tools"])) {
        issues.push({
          code: "bundle.tools.type",
          message: Messages.bundle.toolsType(nameVal),
          path: ["bundles", i, "tools"],
          severity: "error"
        })
      } else if (!(b["tools"].every((t) => isObjectRecord(t)))) {
        issues.push({
          code: "bundle.tools.items",
          message: Messages.bundle.toolsItems(nameVal),
          path: ["bundles", i, "tools"],
          severity: "error"
        })
      }
    })
  }

  // hooks
  const hooks = root?.["hooks"]
  if (Array.isArray(hooks)) {
    hooks.forEach((h, i: number) => {
      if (!isObjectRecord(h)) return
      if (!("on" in h)) {
        issues.push({
          code: "hook.on.missing",
          message: Messages.hook.onMissing(),
          path: ["hooks", i, "on"],
          severity: "error"
        })
      } else if (typeof h["on"] !== "string" && !Array.isArray(h["on"])) {
        issues.push({
          code: "hook.on.type",
          message: Messages.hook.onType(),
          path: ["hooks", i, "on"],
          severity: "error"
        })
      } else {
        const allowed = ["user_message", "assistant_message", "error"]
        const ok = typeof h["on"] === "string"
          ? allowed.includes(h["on"])
          : h["on"].every((x) => allowed.includes(x))
        if (!ok) {
          issues.push({
            code: "hook.on.value",
            message: Messages.hook.onValue(allowed),
            path: ["hooks", i, "on"],
            severity: "error"
          })
        }
      }
      if (!("do" in h) || typeof h["do"] !== "string") {
        issues.push({
          code: "hook.do.missing",
          message: Messages.hook.doMissing(),
          path: ["hooks", i, "do"],
          severity: "error"
        })
      }
    })
  }

  return issues
}
