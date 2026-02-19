# serve.ts usage

## Command

`serve.ts [--port N] [--no-open] (--html TEXT | --file PATH | --stdin)`

You can also pass a positional `PATH` instead of `--file PATH`.

## Options

- `--port N`
  - TCP port to bind (default `8080`).
- `--no-open`
  - Do not auto-open a browser.
- `--html TEXT`
  - Use HTML from an argument string.
- `--file PATH`
  - Read HTML from a file.
- `--stdin`
  - Read HTML from stdin.

If no HTML source is provided, the script reads stdin when available.

## Behavior

- Starts a local HTTP server.
- Serves the page at `/` with `Content-Type: text/html`.
- Opens the URL in the default browser unless `--no-open` is set.
- Stops after the first successful `GET /` request.

## Examples

```text
run serve serve.ts --port 8080 --html "<!doctype html><html>...</html>"
```

```text
run serve serve.ts --file ./preview.html
```
