# Bash completion for the `lectic memory` plugin.

_lectic_complete_memory() {
  local cur
  cur="${COMP_WORDS[COMP_CWORD]}"

  if [[ $COMP_CWORD -eq 2 ]]; then
    COMPREPLY=( $(compgen -W \
      "add search get list update forget history status doctor" \
      -- "$cur") )
    return
  fi

  COMPREPLY=()
}

lectic_register_completion memory _lectic_complete_memory
