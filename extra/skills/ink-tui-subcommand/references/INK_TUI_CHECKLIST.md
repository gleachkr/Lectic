# Ink TUI Checklist

## Import and runtime hygiene

- [ ] React imported explicitly from one esm.sh URL
- [ ] Ink imported with matching `?deps=react@...`
- [ ] No mixed pinned/unpinned React URLs

## Lifecycle

- [ ] `render(..., { exitOnCtrlC: false })`
- [ ] `await waitUntilExit()` is present
- [ ] Alt-screen and cursor restored in `finally`

## lectic script assets

- [ ] Local non-code assets are explicitly imported
- [ ] Runtime reads use `new URL("./asset", import.meta.url)`
- [ ] Missing asset error includes hint about explicit import

## Quality gates

- [ ] `tsc --noEmit`
- [ ] `eslint .`
- [ ] `bun test`
