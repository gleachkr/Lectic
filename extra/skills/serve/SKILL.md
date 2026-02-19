---
name: serve
description: Serve generated HTML to the local browser as a one-shot preview.
---

Use this skill when you want to show the user an interactive HTML artifact
immediately (charts, demos, mockups, small apps).

The script serves one page from a local HTTP server, opens the browser, then
exits after the first successful request to `/`.

## Script

- `scripts/serve.ts`

## Common usage

1. Generate complete HTML (inline CSS/JS in the page).
2. Run:

   `run serve serve.ts --port 8080 --html "<full html here>"`

3. If HTML already exists on disk, use:

   `run serve serve.ts --port 8080 --file ./path/to/page.html`

## Notes

- Prefer inline assets. This is a one-shot local preview server.
- If browser auto-open fails, the script still prints the URL.
- If port 8080 is busy, retry with another port.

See `references/USAGE.md` for full CLI details.
