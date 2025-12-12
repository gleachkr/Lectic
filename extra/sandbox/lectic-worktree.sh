#!/usr/bin/env bash
set -euo pipefail

# -----------------------------------------------------------------------------
# lectic-worktree.sh
#
# Git worktree + bwrap sandbox wrapper.
#
# Intended use: as an `exec`/`mcp_command` sandbox wrapper in Lectic.
#
# What it does:
# - Ensures a git worktree exists for an interlocutor (or explicit name)
# - Optionally creates/checks out a branch for that worktree
# - Runs your command inside bubblewrap with the worktree mounted rw
#
# Notes:
# - This script assumes it is run from within a git repository.
# - The worktree is created under .worktrees/ by default.
# -----------------------------------------------------------------------------

usage() {
  cat <<'EOF'
Usage:
  lectic-worktree.sh [OPTIONS] -- <command> [args...]

Options:
  -n, --name NAME
      Interlocutor name used to namespace the worktree. Defaults to the
      INTERLOCUTOR_NAME environment variable.

  -r, --root DIR
      Worktrees root directory. Default: .worktrees

  -b, --branch BRANCH
      Branch name to use for the worktree. Default:
      lectic-worktree/<sanitized-name>

  --base-ref REF
      When creating a new branch, base it on REF. Default: HEAD

  --no-branch
      Do not use a per-interlocutor branch. Instead, create a detached
      worktree at BASE_REF.

  --bwrap-extra "ARGS"
      Extra arguments appended to the bwrap invocation.

  --print-worktree
      Print the worktree path to stdout and exit.

  --remove
      Remove the worktree and exit (runs: git worktree remove -f).

  -h, --help
      Show this help.

Examples:
  INTERLOCUTOR_NAME=Assistant \
    lectic-worktree.sh -- git status

  lectic-worktree.sh -n Researcher --base-ref main -- \
    bash -lc 'rg -n "TODO" .'

  lectic-worktree.sh -n Assistant --print-worktree
EOF
}

die() {
  echo "Error: $*" >&2
  exit 1
}

require_cmd() {
  local cmd="$1"
  if ! command -v "$cmd" >/dev/null 2>&1; then
    die "'$cmd' is not installed or not in PATH"
  fi
}

sanitize_name() {
  local name="$1"
  local safe
  safe=$(echo "$name" | tr -cd '[:alnum:]-_')
  if [[ -z "$safe" ]]; then
    die "name contains no valid characters: '$name'"
  fi
  printf %s "$safe"
}

require_cmd bwrap
require_cmd git

NAME="${INTERLOCUTOR_NAME:-}"
WORKTREES_ROOT=".worktrees"
BRANCH_NAME=""
BASE_REF="HEAD"
NO_BRANCH=0
BWRAP_EXTRA=""
PRINT_WORKTREE=0
REMOVE_WORKTREE=0

ARGS=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    -n|--name)
      [[ $# -ge 2 ]] || die "--name requires a value"
      NAME="$2"
      shift 2
      ;;
    -r|--root)
      [[ $# -ge 2 ]] || die "--root requires a value"
      WORKTREES_ROOT="$2"
      shift 2
      ;;
    -b|--branch)
      [[ $# -ge 2 ]] || die "--branch requires a value"
      BRANCH_NAME="$2"
      shift 2
      ;;
    --base-ref)
      [[ $# -ge 2 ]] || die "--base-ref requires a value"
      BASE_REF="$2"
      shift 2
      ;;
    --no-branch)
      NO_BRANCH=1
      shift
      ;;
    --bwrap-extra)
      [[ $# -ge 2 ]] || die "--bwrap-extra requires a value"
      BWRAP_EXTRA="$2"
      shift 2
      ;;
    --print-worktree)
      PRINT_WORKTREE=1
      shift
      ;;
    --remove)
      REMOVE_WORKTREE=1
      shift
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
    *)
      die "unknown arg: $1 (use --help)"
      ;;
  esac
done

[[ -n "$NAME" ]] || die "no name provided (set INTERLOCUTOR_NAME or --name)"

SAFE_NAME=$(sanitize_name "$NAME")
TARGET_DIR="${WORKTREES_ROOT}/${SAFE_NAME}"

if [[ -z "$BRANCH_NAME" ]]; then
  BRANCH_NAME="lectic-worktree/${SAFE_NAME}"
fi

# Worktree Management ---------------------------------------------------------

# Resolve repository root and ensure we are inside a git repo.
if ! REPO_ROOT=$(git rev-parse --show-toplevel 2>/dev/null); then
  die "not inside a git repository (run from within a repo)"
fi

# Always place the worktrees root at the repo root, regardless of the
# current working directory.
WORKTREES_ROOT="${REPO_ROOT}/${WORKTREES_ROOT}"
TARGET_DIR="${WORKTREES_ROOT}/${SAFE_NAME}"

# Need absolute path for bwrap binding and chdir.
ABS_TARGET_DIR=$(cd "$TARGET_DIR" 2>/dev/null && pwd -P || true)

mkdir -p "$WORKTREES_ROOT"

ensure_worktree() {
  if [[ -d "$TARGET_DIR" ]]; then
    if [[ ! -f "$TARGET_DIR/.git" ]]; then
      die "$TARGET_DIR exists but does not appear to be a git worktree"
    fi

    ABS_TARGET_DIR=$(cd "$TARGET_DIR" && pwd -P)
    return 0
  fi

  if [[ "$NO_BRANCH" -eq 1 ]]; then
    git worktree add --detach "$TARGET_DIR" "$BASE_REF"
    return 0
  fi

  if git show-ref --verify --quiet "refs/heads/${BRANCH_NAME}"; then
    git worktree add "$TARGET_DIR" "$BRANCH_NAME"
  else
    git worktree add -b "$BRANCH_NAME" "$TARGET_DIR" "$BASE_REF"
  fi
}

ensure_worktree

if [[ "$REMOVE_WORKTREE" -eq 1 ]]; then
  git worktree remove -f "$TARGET_DIR"
  exit 0
fi

if [[ "$PRINT_WORKTREE" -eq 1 ]]; then
  echo "$ABS_TARGET_DIR"
  exit 0
fi

[[ ${#ARGS[@]} -gt 0 ]] || die "missing command (use -- <command> ...)"

# Execution ------------------------------------------------------------------

# bwrap setup:
# - ro-bind / /      : read-only system
# - bind worktree    : rw access to the worktree only
# - tmpfs /tmp,...   : writable temp areas
# - unshare pid      : isolate process tree
#
# NOTE: This still inherits your network namespace. If you want to block
# networking, add something like: --unshare-net

BWRAP_ARGS=(
  --ro-bind / /
  --dev /dev
  --proc /proc
  --tmpfs /tmp
  --tmpfs /var/tmp
  --bind "$ABS_TARGET_DIR" "$ABS_TARGET_DIR"
  --chdir "$ABS_TARGET_DIR"
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
