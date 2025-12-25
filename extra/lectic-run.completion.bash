# Completion plugin for the `lectic run` subcommand.
#
# This file is designed to be sourced by
# `extra/tab_complete/lectic_bash_completion.bash` via the adjacent-plugin
# mechanism:
#
#   lectic-run.js  ->  lectic-run.completion.bash

_lectic_complete_run() {
  local cur prev
  cur="${COMP_WORDS[COMP_CWORD]}"
  prev="${COMP_WORDS[COMP_CWORD-1]}"

  local flags="--list -l --save --edit -e --help -h"

  # If completing a flag, offer all flags.
  if [[ "$cur" == -* ]]; then
    COMPREPLY=( $(compgen -W "$flags" -- "$cur") )
    return 0
  fi

  # Identify if a template name has already been provided among the
  # positional arguments.
  local i word template_found=""
  local run_found=0
  for (( i=1; i < COMP_CWORD; i++ )); do
    word="${COMP_WORDS[i]}"
    if [[ "$run_found" -eq 1 ]]; then
      if [[ "$word" != -* ]]; then
        template_found="$word"
        break
      fi
    elif [[ "$word" == "run" ]]; then
      run_found=1
    fi
  done

  # If no template is found yet, or if the user is explicitly requesting
  # an edit or save, suggest template names from the run directory.
  if [[ -z "$template_found" ]] || [[ "$prev" == "--edit" ]] || \
     [[ "$prev" == "-e" ]] || [[ "$prev" == "--save" ]]; then
    
    # Resolve the Lectic data directory to find templates.
    local data_dir="${LECTIC_DATA:-${__LECTIC_DATA_DIR}}"
    if [[ -z "$data_dir" ]]; then
       data_dir="${XDG_DATA_HOME:-$HOME/.local/share}/lectic"
    fi
    local run_dir="${data_dir}/run"

    if [[ -d "$run_dir" ]]; then
      local templates
      # We use find to list .lec files and strip the extension for the
      # template name.
      templates=$(find "$run_dir" -maxdepth 1 -name "*.lec" \
                  -exec basename {} .lec \;)
      COMPREPLY=( $(compgen -W "$templates" -- "$cur") )
    fi
  fi

  return 0
}

# Register the function with the main Lectic completion engine.
lectic_register_completion run _lectic_complete_run
