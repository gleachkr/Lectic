# Bash completion for the `lectic goal` plugin.

_lectic_complete_goal() {
  local cur prev cmd
  cur="${COMP_WORDS[COMP_CWORD]}"
  prev="${COMP_WORDS[COMP_CWORD-1]}"
  cmd="${COMP_WORDS[2]:-}"
  COMPREPLY=()

  if [[ "$COMP_CWORD" -eq 2 ]]; then
    COMPREPLY=( $(compgen -W \
      "set show handoff complete resume final clear --help -h" \
      -- "$cur") )
    return
  fi

  case "$prev" in
    --goal|--briefing|--summary|--goal-dir|--interlocutor|--file)
      return
      ;;
  esac

  case "$cmd" in
    set)
      COMPREPLY=( $(compgen -W \
        "--goal --force --json --goal-dir --interlocutor --file" \
        -- "$cur") )
      ;;
    handoff)
      COMPREPLY=( $(compgen -W \
        "--briefing --json --goal-dir --interlocutor --file" \
        -- "$cur") )
      ;;
    complete)
      COMPREPLY=( $(compgen -W \
        "--summary --json --goal-dir --interlocutor --file" \
        -- "$cur") )
      ;;
    clear)
      COMPREPLY=( $(compgen -W \
        "--force --json --goal-dir --interlocutor --file" \
        -- "$cur") )
      ;;
    *)
      COMPREPLY=( $(compgen -W \
        "--json --goal-dir --interlocutor --file --help -h" \
        -- "$cur") )
      ;;
  esac
}

lectic_register_completion goal _lectic_complete_goal
