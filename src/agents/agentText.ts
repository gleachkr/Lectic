export function normalizeAgentText(text: string): string {
  // Preserve leading whitespace (can be meaningful in markdown/code).
  return text.replace(/\r\n/g, "\n").trimEnd()
}
