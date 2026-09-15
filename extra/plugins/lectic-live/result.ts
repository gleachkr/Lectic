import { record, text } from "./protocol"

export type BackendResult = {
  status: "completed" | "clarification" | "failed"
  summary: string
}

export function extractResult(parsed: unknown): BackendResult {
  const messages = record(parsed)["messages"]
  if (!Array.isArray(messages) || !messages.length) {
    throw new Error("Missing completed backend record")
  }
  const last = record(messages.at(-1))
  if (last["role"] !== "assistant" || !Array.isArray(last["content"])) {
    throw new Error("Backend did not end with an assistant answer")
  }
  const nodes = last["content"].map(record)
  // A zero exit can still contain a runaway-tool or hook error. Reject it.
  for (const node of nodes) {
    if (node["type"] === "html"
      && !text(node["value"]).trim().startsWith("<!--")) {
      throw new Error("Unknown markup or backend error in terminal record")
    }
  }
  // Structured parsing supplies tool/thought/attachment nodes. Only accept
  // the final node's explicit envelope, never recover by returning stdout.
  const terminal = nodes.at(-1)
  if (terminal?.["type"] !== "code"
    || terminal["lang"] !== "lectic-live-result") {
    throw new Error("Missing terminal result envelope")
  }
  const value = record(JSON.parse(text(terminal["value"])))
  const status = value["status"]
  if ((status !== "completed" && status !== "clarification"
    && status !== "failed")
    || Object.keys(value).sort().join(",") !== "status,summary") {
    throw new Error("Malformed terminal result envelope")
  }
  const summary = text(value["summary"])
  if (!summary.trim() || Buffer.byteLength(summary) > 400) {
    throw new Error("Terminal result exceeds conservative append bound")
  }
  return { status, summary }
}
