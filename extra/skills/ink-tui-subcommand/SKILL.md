---
name: ink-tui-subcommand
description: Build and debug Lectic subcommands with Ink/React TUI patterns.
---

# Ink TUI Subcommand Skill

Use this skill when creating or fixing `lectic script` subcommands that render
interactive TUIs with Ink.

## When to use

- New `extra/lectic-*.tsx` or plugin subcommand scaffolds
- Input handling bugs (`useInput`, mode switching, key collisions)
- React instance mismatch problems from esm.sh imports
- Lifecycle bugs where TUI exits immediately

## Core patterns

1. **Keep React graph unified**
   - Import React explicitly from one URL.
   - Import Ink from esm.sh with matching React dependency.
   - Example:
     - `react@18.3.1`
     - `ink@5.2.1?deps=react@18.3.1`

2. **Wait for Ink app exit**
   - `const { waitUntilExit } = render(...)`
   - `await waitUntilExit()`

3. **Use alt-screen safely**
   - Enter alt-screen only when `stdout.isTTY`.
   - Restore cursor + screen in `finally`.
   - Use alt-screen for immersive apps, skip it for inline widget apps

4. **Support local runtime assets in lectic script**
   - Explicitly import local non-code assets.
   - Example: `import "./schema.sql"`
   - Then resolve with `new URL("./schema.sql", import.meta.url)`.

5. **Make sure keyboard shortcuts don't collide with text entry**
   - Try putting text entry for query or filter behind a "mode" which can be 
     exited with ESC

## Minimal scaffold

```tsx
#!/usr/bin/env -S lectic script
import React from "https://esm.sh/react@18.3.1";
import { render, Box, Text, useInput, useApp }
  from "https://esm.sh/ink@5.2.1?deps=react@18.3.1";

function App() {
  const { exit } = useApp();
  useInput((input, key) => {
    if ((key.ctrl && input === "c") || input === "q") exit();
  });
  return <Box><Text>TUI ready (q to quit)</Text></Box>;
}

const { waitUntilExit } = render(<App />, { exitOnCtrlC: false });
await waitUntilExit();
```

## Verification checklist

See `references/INK_TUI_CHECKLIST.md`.
