import type { InitializeParams } from "vscode-languageserver"

// Return workspace roots as filesystem paths. Only file:// URIs are used.
// Note: VS Code provides folder URIs that already point to the folder
// root. We must not strip a path segment (no dirname); keep pathname.
export function extractWorkspaceRoots(params: InitializeParams): string[] {
  const roots: string[] = []
  if (Array.isArray(params.workspaceFolders)) {
    for (const wf of params.workspaceFolders) {
      try {
        const u = new URL(wf.uri)
        if (u.protocol === 'file:') roots.push(u.pathname)
      } catch {
        // ignore bad URIs
      }
    }
  }
  // Fallback: if no workspaceFolders but rootUri exists (older clients),
  // honor it when it is a file URI.
  if (roots.length === 0 && (params as any)?.rootUri) {
    try {
      const u = new URL((params as any).rootUri)
      if (u.protocol === 'file:') roots.push(u.pathname)
    } catch {
      // ignore
    }
  }
  return roots
}
