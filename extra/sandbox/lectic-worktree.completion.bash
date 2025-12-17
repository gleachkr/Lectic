# Completion plugin for the `lectic worktree` subcommand.
#
# This file is designed to be sourced by
# `extra/tab_complete/lectic_bash_completion.sh` via the adjacent-plugin
# mechanism:
#
#   lectic-worktree(.sh)  ->  lectic-worktree.completion.(bash)

_lectic_complete_worktree() {
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
    -r|--root)
      COMPREPLY=( $(compgen -d -- "${cur}") )
      return 0
      ;;
    -n|--name|-b|--branch|--base-ref|--bwrap-extra)
      return 0
      ;;
  esac

  local opts
  opts="-n --name -r --root -b --branch --base-ref --no-branch "
  opts+="--bwrap-extra --print-worktree --remove -d --delete -h --help --"

  COMPREPLY=( $(compgen -W "${opts}" -- "${cur}") )

  return 0
}

lectic_register_completion worktree _lectic_complete_worktree
