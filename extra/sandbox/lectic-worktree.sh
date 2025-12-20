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
      Name used to namespace the worktree. Defaults to "Assistant".

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

  -d, --delete
      Delete the worktree directory AND its associated branch.
      If the branch contains unmerged commits, ask for confirmation.

  -h, --help
      Show this help.

Examples:
  lectic-worktree.sh -n Assistant -- git status

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

NAME=""
DEFAULT_NAME="Assistant"
WORKTREES_ROOT=".worktrees"
BRANCH_NAME=""
BASE_REF="HEAD"
NO_BRANCH=0
BWRAP_EXTRA=""
PRINT_WORKTREE=0
REMOVE_WORKTREE=0
DELETE_WORKTREE=0

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
    -d|--delete)
      DELETE_WORKTREE=1
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

if [[ -z "$NAME" ]]; then
  NAME="$DEFAULT_NAME"
fi

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

# Need absolute path for bwrap binding and chdir.
ABS_TARGET_DIR=$(cd "$TARGET_DIR" && pwd -P)
[[ -d "$ABS_TARGET_DIR" ]] || die "worktree dir missing: $ABS_TARGET_DIR"

if [[ "$REMOVE_WORKTREE" -eq 1 ]]; then
  git worktree remove -f "$TARGET_DIR"
  exit 0
fi

confirm_delete_branch_if_needed() {
  local branch="$1"

  if [[ "$NO_BRANCH" -eq 1 ]]; then
    die "--delete cannot be used with --no-branch"
  fi

  if ! git show-ref --verify --quiet "refs/heads/${branch}"; then
    return 0
  fi

  local default_base_branch
  if git show-ref --verify --quiet refs/heads/main; then
    default_base_branch="main"
  elif git show-ref --verify --quiet refs/heads/master; then
    default_base_branch="master"
  else
    default_base_branch=""
  fi

  if [[ -n "$default_base_branch" ]]; then
    if git merge-base --is-ancestor "$branch" "$default_base_branch"; then
      return 0
    fi

    echo "Branch '${branch}' contains commits not merged into" \
      "${default_base_branch}." >&2
    read -r -p "Delete branch anyway? [y/N] " ans
    case "$ans" in
      y|Y|yes|YES)
        return 0
        ;;
      *)
        echo "Aborting." >&2
        exit 1
        ;;
    esac
  fi
}

if [[ "$DELETE_WORKTREE" -eq 1 ]]; then
  confirm_delete_branch_if_needed "$BRANCH_NAME"
  git worktree remove -f "$TARGET_DIR" || true
  if git show-ref --verify --quiet "refs/heads/${BRANCH_NAME}"; then
    git branch -D "$BRANCH_NAME"
  fi
  exit 0
fi

if [[ "$PRINT_WORKTREE" -eq 1 ]]; then
  echo "$ABS_TARGET_DIR"
  exit 0
fi

[[ ${#ARGS[@]} -gt 0 ]] || die "missing command (use -- <command> ...)"

# Execution ------------------------------------------------------------------

# bwrap setup:
# - ro-bind / /            : read-only system
# - bind worktree          : rw access to the worktree only
# - bind repo git dir (ro) : lets git operations work inside the worktree
# - tmpfs /tmp,...         : writable temp areas
# - unshare pid            : isolate process tree
#
# NOTE: This still inherits your network namespace. If you want to block
# networking, add something like: --unshare-net

ABS_REPO_ROOT=$(cd "$REPO_ROOT" && pwd -P)
ABS_GIT_COMMON_DIR=$(cd "$(git rev-parse --git-common-dir)" && pwd -P)
ABS_GIT_DIR=$(
  cd "$ABS_TARGET_DIR" && git rev-parse --git-dir
)

BWRAP_ARGS=(
  --ro-bind / /
  --dev /dev
  --proc /proc
  --tmpfs /tmp
  --tmpfs /var/tmp
  --bind "$ABS_TARGET_DIR" "$ABS_TARGET_DIR"
  --bind "$ABS_GIT_COMMON_DIR" "$ABS_GIT_COMMON_DIR"
  --setenv GIT_DIR "$ABS_GIT_DIR"
  --setenv GIT_COMMON_DIR "$ABS_GIT_COMMON_DIR"
  --setenv GIT_WORK_TREE "$ABS_TARGET_DIR"
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
