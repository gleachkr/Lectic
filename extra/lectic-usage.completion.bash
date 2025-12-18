# Completion plugin for the `lectic usage` subcommand.
#
# This file is designed to be sourced by
# `extra/tab_complete/lectic_bash_completion.sh` via the adjacent-plugin
# mechanism:
#
#   lectic-usage.py  ->  lectic-usage.completion.bash

_lectic_complete_usage() {
  local cur prev
  cur="${COMP_WORDS[COMP_CWORD]}"
  prev="${COMP_WORDS[COMP_CWORD-1]}"

  case "${prev}" in
    -g|--granularity)
      COMPREPLY=( $(compgen -W "hour day week month" -- "${cur}") )
      return 0
      ;;
    -u|--units|-f|--filter)
      return 0
      ;;
  esac

  local opts
  opts="--hook -g --granularity -u --units -f --filter -h --help"

  COMPREPLY=( $(compgen -W "${opts}" -- "${cur}") )

  return 0
}

lectic_register_completion usage _lectic_complete_usage
