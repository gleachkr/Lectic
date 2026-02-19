# Bash completion for lectic task plugin

_lectic_complete_task() {
  local cur prev
  cur="${COMP_WORDS[COMP_CWORD]}"
  prev="${COMP_WORDS[COMP_CWORD-1]}"

  if [[ $COMP_CWORD -eq 2 ]]; then
    COMPREPLY=( $(compgen -W \
      "create list show transition note attach next archive render-todo doctor complete" \
      -- "$cur") )
    return
  fi

  case "${COMP_WORDS[2]}" in
    transition)
      if [[ $COMP_CWORD -eq 4 ]]; then
        COMPREPLY=( $(compgen -W \
          "not_started researching researched planning planned implementing completed partial blocked abandoned" \
          -- "$cur") )
      fi
      ;;
    attach)
      if [[ "$prev" == "--kind" ]]; then
        COMPREPLY=( $(compgen -W "report plan summary code doc other" -- "$cur") )
      fi
      ;;
  esac
}

lectic_register_completion task _lectic_complete_task
