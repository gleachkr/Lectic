# Bash completion for the lectic undo plugin
#
# Loaded by Lectic's main bash completion script via the adjacent-plugin
# mechanism.

__lectic_undo_snapshot_ids() {
  local ids
  ids=$(lectic undo list 2>/dev/null | awk -F '\t' 'NF > 1 { print $1 }')
  printf '%s\n' "$ids"
}

_lectic_complete_undo() {
  local cur prev cmd
  cur="${COMP_WORDS[COMP_CWORD]}"
  prev="${COMP_WORDS[COMP_CWORD-1]}"
  COMPREPLY=()

  cmd=""
  if [[ ${#COMP_WORDS[@]} -ge 3 ]]; then
    cmd="${COMP_WORDS[2]}"
  fi

  if [[ "$COMP_CWORD" -eq 2 ]]; then
    COMPREPLY=( $(compgen -W \
      "capture note list show diff restore prune --help -h" -- "$cur") )
    return 0
  fi

  case "$cmd" in
    show)
      COMPREPLY=( $(compgen -W "$(__lectic_undo_snapshot_ids)" -- "$cur") )
      return 0
      ;;
    diff)
      if [[ "$cur" == -* ]]; then
        COMPREPLY=( $(compgen -W "--index --help -h" -- "$cur") )
      elif [[ "$prev" != "--index" ]]; then
        COMPREPLY=( $(compgen -W \
          "$(__lectic_undo_snapshot_ids)" -- "$cur") )
      fi
      return 0
      ;;
    restore)
      if [[ "$cur" == -* ]]; then
        COMPREPLY=( $(compgen -W \
          "--worktree-only --index-only --help -h" -- "$cur") )
      else
        COMPREPLY=( $(compgen -W \
          "$(__lectic_undo_snapshot_ids)" -- "$cur") )
      fi
      return 0
      ;;
    prune)
      if [[ "$prev" == "--keep-last" ]]; then
        return 0
      fi
      if [[ "$cur" == -* ]]; then
        COMPREPLY=( $(compgen -W "--keep-last --all --help -h" -- "$cur") )
      fi
      return 0
      ;;
    capture|note|list)
      if [[ "$cur" == -* ]]; then
        COMPREPLY=( $(compgen -W "--help -h" -- "$cur") )
      fi
      return 0
      ;;
    "")
      if [[ "$cur" == -* ]]; then
        COMPREPLY=( $(compgen -W "--help -h" -- "$cur") )
      fi
      return 0
      ;;
  esac

  if [[ "$cur" == -* ]]; then
    COMPREPLY=( $(compgen -W "--help -h" -- "$cur") )
  fi

  return 0
}

lectic_register_completion undo _lectic_complete_undo
