#!/bin/bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  lectic-bwrap.sh [OPTIONS] [--] <command> [args...]

A simple bubblewrap sandbox wrapper for Lectic.

Options:
  -d, --dir DIR
      Directory to bind-mount and use as the current working directory.
      Defaults to the current directory.

  --bwrap-extra "ARGS"
      Extra arguments appended to the bwrap invocation.

  -h, --help
      Show this help.

Examples:
  # Run a command in a sandbox in the current directory
  lectic-bwrap.sh -- ls -la

  # Run a command in a specific directory
  lectic-bwrap.sh -d ./my-project -- bash -c 'cat src/main.ts'

  # Pass extra arguments to bwrap (e.g. enable networking)
  lectic-bwrap.sh --bwrap-extra "--share-net" -- curl https://example.com
EOF
}

die() {
  echo "Error: $*" >&2
  exit 1
}

# --- Argument Parsing ---

BIND_DIR="$PWD"
BWRAP_EXTRA=""
ARGS=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    -d|--dir)
      [[ $# -ge 2 ]] || die "--dir requires a value"
      BIND_DIR="$2"
      shift 2
      ;;
    --bwrap-extra)
      [[ $# -ge 2 ]] || die "--bwrap-extra requires a value"
      BWRAP_EXTRA="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    --)
      shift
      ARGS=("$@")
      break
      ;;
    -*)
      die "unknown arg: $1 (use --help)"
      ;;
    *)
      # Treat the first unknown non-option as the start of the command
      # if we haven't seen -- yet.
      ARGS=("$@")
      break
      ;;
  esac
done

[[ ${#ARGS[@]} -gt 0 ]] || die "missing command (use -- <command> ...)"

if ! command -v bwrap >/dev/null 2>&1; then
  die "bwrap needs to be installed to use this sandbox"
fi

# --- Execution ---

ABS_BIND_DIR=$(realpath "$BIND_DIR")
[[ -d "$ABS_BIND_DIR" ]] || die "directory does not exist: $ABS_BIND_DIR"

BWRAP_ARGS=(
  --ro-bind / /
  --dev /dev
  --proc /proc
  --tmpfs /tmp
  --tmpfs /var/tmp
  --bind "$ABS_BIND_DIR" "$ABS_BIND_DIR"
  --chdir "$ABS_BIND_DIR"
  --unshare-pid
  --new-session
  --die-with-parent
)

if [[ -n "$BWRAP_EXTRA" ]]; then
  # Split user-provided args on spaces (simple but fine for CLI usage).
  # If you need complex quoting, wrap this script and pass explicit args.
  read -r -a EXTRA_ARR <<<"$BWRAP_EXTRA"
  BWRAP_ARGS+=("${EXTRA_ARR[@]}")
fi

exec bwrap "${BWRAP_ARGS[@]}" "${ARGS[@]}"
