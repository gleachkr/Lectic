# Nix Sandbox Plugin (Container-Based PoC)

This plugin is a proof of concept for a declarative, container-backed Lectic
sandbox.

It provides:

- `flake.nix` with a declared container image (`.#containerImage`)
- `lectic-nix-sandbox`, a Lectic sandbox wrapper using Nix + Podman
- `lectic.yaml` to enable the wrapper as a default sandbox
- `packages.example.nix` for easy package customization

## Default behavior

By default, `lectic-nix-sandbox`:

- builds `path:<plugin-dir>#containerImage` with `nix build`
- does not write `flake.lock` during tool execution
- stores Podman state under `LECTIC_CACHE` / `LECTIC_TEMP`
- keeps a warm background container per sandbox config
- prunes warm containers idle longer than 900 seconds
- runs tool commands in that container
- disables networking unless `--allow-net` is set

## Install and import

### Option A: install under `LECTIC_DATA` (or `LECTIC_CONFIG`)

```bash
mkdir -p "$LECTIC_DATA/plugins/nix-sandbox"
cp -r ./extra/plugins/nix-sandbox/* "$LECTIC_DATA/plugins/nix-sandbox/"
chmod +x "$LECTIC_DATA/plugins/nix-sandbox/lectic-nix-sandbox"
```

Then import from project config:

```yaml
imports:
  - $LECTIC_DATA/plugins/nix-sandbox/lectic.yaml
```

### Option B: keep plugin in-repo

```yaml
imports:
  - ./extra/plugins/nix-sandbox/lectic.yaml
```

## Persistent storage

Mount a persistent directory at `/persist`:

```yaml
sandbox: local:./extra/plugins/nix-sandbox/lectic-nix-sandbox \
  --persist $LECTIC_DATA/nix-sandbox/$LECTIC_INTERLOCUTOR
```

Add another mounted volume:

```yaml
sandbox: local:./extra/plugins/nix-sandbox/lectic-nix-sandbox \
  --persist $LECTIC_DATA/nix-sandbox/$LECTIC_INTERLOCUTOR \
  --volume $PWD/.cache:/workspace-cache
```

## Warm-container controls

Disable warming for a specific sandbox:

```yaml
sandbox: local:./extra/plugins/nix-sandbox/lectic-nix-sandbox \
  --no-keep-warm
```

Set idle timeout to 30 minutes:

```yaml
sandbox: local:./extra/plugins/nix-sandbox/lectic-nix-sandbox \
  --warm-ttl-seconds 1800
```

## Add extra packages without editing plugin internals

Pass a nix file returning extra derivations:

```yaml
sandbox: local:./extra/plugins/nix-sandbox/lectic-nix-sandbox \
  --nix-packages-file ./extra/plugins/nix-sandbox/packages.example.nix
```

The file may return:

- a list of derivations, or
- an attrset like `{ packages = [ ... ]; }`

It may also be a function receiving `{ pkgs, callPackage }`.

See `packages.example.nix`.

## Notes on host filesystem pollution

This wrapper avoids global Podman state by default and writes to:

- `LECTIC_CACHE/nix-sandbox`
  - `podman-root/` (image + container storage)
  - `warm-home/` (persistent home dirs for warm containers)
  - `warm-state/` (warm container marker files)
- `LECTIC_TEMP/nix-sandbox`
  - `podman-runroot/` (Podman runroot)
  - `xdg-runtime/` (runtime dir used for Podman)
  - `policy.json`, `registries.conf` (local Podman config)

In normal Lectic runs, `LECTIC_CACHE` and `LECTIC_TEMP` are set for you
automatically. If you want different state locations, override those vars.

## Manual smoke checks

```bash
./extra/plugins/nix-sandbox/lectic-nix-sandbox --help
./extra/plugins/nix-sandbox/lectic-nix-sandbox -- bash -lc 'echo ok; pwd; id'
```

If your environment has read-only home/cache paths, set writable overrides:

```bash
LECTIC_CACHE=/tmp/lectic-cache \
LECTIC_TEMP=/tmp/lectic-tmp \
XDG_CACHE_HOME=/tmp/xdg-cache \
./extra/plugins/nix-sandbox/lectic-nix-sandbox -- bash -lc 'echo ok'
```

## Current limitations

1. Plugin installation is manual.
2. Imports and runtime command discovery are separate.
3. Cold start is still expensive (`nix build` + image load).
4. Commands currently run as root inside the container.
