# Completion plugin for the `lectic bwrap` subcommand.
#
# This file is designed to be sourced by
# `extra/tab_complete/lectic_bash_completion.sh` via the adjacent-plugin
# mechanism:
#
#   lectic-bwrap(.sh)  ->  lectic-bwrap.completion.(bash)

_lectic_complete_bwrap() {
  local cur prev
  cur="${COMP_WORDS[COMP_CWORD]}"
  prev="${COMP_WORDS[COMP_CWORD-1]}"

  # If the user has typed "--", complete the command that follows.
  local i
  for ((i = 0; i < ${#COMP_WORDS[@]}; i++)); do
    if [[ "${COMP_WORDS[i]}" == "--" ]]; then
      if (( COMP_CWORD > i )); then
        COMPREPLY=( $(compgen -c -- "${cur}") )
        return 0
      fi
    fi
  done

  case "${prev}" in
    -d|--dir)
      COMPREPLY=( $(compgen -d -- "${cur}") )
      return 0
      ;;
    --bwrap-extra)
      return 0
      ;;
  esac

  if [[ "${cur}" == -* ]]; then
    local opts="-d --dir --bwrap-extra -h --help --"
    COMPREPLY=( $(compgen -W "${opts}" -- "${cur}") )
    return 0
  fi

  # Suggest commands to execute.
  COMPREPLY=( $(compgen -c -- "${cur}") )

  return 0
}

lectic_register_completion bwrap _lectic_complete_bwrap
