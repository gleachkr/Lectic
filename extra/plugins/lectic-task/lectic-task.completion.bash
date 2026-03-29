# Bash completion for lectic task and taskboard plugins
#
# Loaded by lectic_bash_completion.bash via the adjacent-plugin mechanism.

# --- Helpers ---

# Find the index of the task/taskboard subcommand in COMP_WORDS.
# Global flags like --file, --log may appear before it.
__lectic_task_find_subcmd_idx() {
  local i word
  for (( i=1; i < ${#COMP_WORDS[@]}; i++ )); do
    word="${COMP_WORDS[i]}"
    case "$word" in
      task|taskboard) echo "$i"; return 0 ;;
      -f|--file|-l|--log|--format) ((i++)) ;;  # skip value
      --file=*|--log=*|--format=*) ;;
      -*) ;;
    esac
  done
  echo ""
  return 1
}

# Position of the first task sub-subcommand relative to the task subcommand.
# e.g. in "lectic task --db foo create", the sub-subcommand is "create".
__lectic_task_find_cmd() {
  local start="$1"
  local i word
  for (( i=start+1; i < ${#COMP_WORDS[@]}; i++ )); do
    word="${COMP_WORDS[i]}"
    case "$word" in
      --db) ((i++)) ;;   # skip --db value
      --db=*|--json) ;;
      -*) ;;
      *)
        __lectic_task_cmd="$word"
        __lectic_task_cmd_idx="$i"
        return 0
        ;;
    esac
  done
  __lectic_task_cmd=""
  __lectic_task_cmd_idx=""
  return 1
}

# --- Constants ---

__LECTIC_TASK_SUBCOMMANDS="create edit list show transition note attach next archive render-todo doctor complete"
__LECTIC_TASK_STATUSES="not_started researching researched planning planned implementing completed partial blocked abandoned"
__LECTIC_TASK_LANGUAGES="general neovim latex typst meta markdown"
__LECTIC_TASK_PRIORITIES="low medium high critical"
__LECTIC_TASK_ARTIFACT_KINDS="report plan summary code doc other"
__LECTIC_TASK_SORT_FIELDS="updated created priority"

# --- lectic task completion ---

_lectic_complete_task() {
  local cur prev
  cur="${COMP_WORDS[COMP_CWORD]}"
  prev="${COMP_WORDS[COMP_CWORD-1]}"
  COMPREPLY=()

  local subcmd_idx
  subcmd_idx="$(__lectic_task_find_subcmd_idx)"
  [[ -n "$subcmd_idx" ]] || return 0

  # Complete --db value with file paths
  if [[ "$prev" == "--db" ]]; then
    COMPREPLY=( $(compgen -f -- "$cur") )
    return 0
  fi

  # Find the task sub-subcommand (create, list, etc.)
  local __lectic_task_cmd __lectic_task_cmd_idx
  __lectic_task_find_cmd "$subcmd_idx"

  # If no sub-subcommand yet, offer global task flags and subcommands
  if [[ -z "$__lectic_task_cmd" ]]; then
    if [[ "$cur" == -* ]]; then
      COMPREPLY=( $(compgen -W "--db --json --help -h" -- "$cur") )
    else
      COMPREPLY=( $(compgen -W "$__LECTIC_TASK_SUBCOMMANDS" -- "$cur") )
    fi
    return 0
  fi

  # If cursor is on the sub-subcommand itself, complete it
  if [[ "$COMP_CWORD" -eq "$__lectic_task_cmd_idx" ]]; then
    COMPREPLY=( $(compgen -W "$__LECTIC_TASK_SUBCOMMANDS" -- "$cur") )
    return 0
  fi

  # --- Per-subcommand completion ---

  # Helper: complete enum values for the previous flag
  case "$prev" in
    --lang)
      COMPREPLY=( $(compgen -W "$__LECTIC_TASK_LANGUAGES" -- "$cur") )
      return 0
      ;;
    --priority)
      COMPREPLY=( $(compgen -W "$__LECTIC_TASK_PRIORITIES" -- "$cur") )
      return 0
      ;;
    --status)
      COMPREPLY=( $(compgen -W "$__LECTIC_TASK_STATUSES" -- "$cur") )
      return 0
      ;;
    --kind)
      COMPREPLY=( $(compgen -W "$__LECTIC_TASK_ARTIFACT_KINDS" -- "$cur") )
      return 0
      ;;
    --sort)
      COMPREPLY=( $(compgen -W "$__LECTIC_TASK_SORT_FIELDS" -- "$cur") )
      return 0
      ;;
    --path|--out)
      COMPREPLY=( $(compgen -f -- "$cur") )
      return 0
      ;;
    # Flags that take free-form text — don't complete
    --title|--desc|--text|--summary|--note|--effort|--parent|--limit|--offset|--query|--actor|--session)
      return 0
      ;;
  esac

  # If typing a flag, offer subcommand-specific flags
  if [[ "$cur" == -* ]]; then
    local flags=""
    case "$__lectic_task_cmd" in
      create)
        flags="--title --desc --lang --priority --effort --parent --editor --actor --session --help -h"
        ;;
      edit)
        flags="--actor --session --help -h"
        ;;
      list)
        flags="--status --lang --priority --query --limit --offset --sort --help -h"
        ;;
      show)
        flags="--help -h"
        ;;
      transition)
        flags="--note --actor --session --help -h"
        ;;
      note)
        flags="--text --actor --session --help -h"
        ;;
      attach)
        flags="--kind --path --summary --actor --session --help -h"
        ;;
      next)
        flags="--lang --help -h"
        ;;
      archive)
        flags="--actor --session --help -h"
        ;;
      render-todo)
        flags="--out --help -h"
        ;;
      doctor)
        flags="--help -h"
        ;;
      complete)
        flags="--status --lang --limit --help -h"
        ;;
    esac
    [[ -n "$flags" ]] && COMPREPLY=( $(compgen -W "$flags" -- "$cur") )
    return 0
  fi

  # Positional completion for specific subcommands
  case "$__lectic_task_cmd" in
    transition)
      # Count positional args after the subcommand (skip flags and their values)
      local pos=0 j word
      for (( j=__lectic_task_cmd_idx+1; j < COMP_CWORD; j++ )); do
        word="${COMP_WORDS[j]}"
        case "$word" in
          --note|--actor|--session) ((j++)) ;;
          -*) ;;
          *) ((pos++)) ;;
        esac
      done
      # pos 0 = task id (no completion), pos 1 = target status
      if [[ "$pos" -eq 1 ]]; then
        COMPREPLY=( $(compgen -W "$__LECTIC_TASK_STATUSES" -- "$cur") )
      fi
      ;;
  esac

  return 0
}

# --- lectic taskboard completion ---

_lectic_complete_taskboard() {
  local cur prev
  cur="${COMP_WORDS[COMP_CWORD]}"
  prev="${COMP_WORDS[COMP_CWORD-1]}"
  COMPREPLY=()

  if [[ "$prev" == "--db" ]]; then
    COMPREPLY=( $(compgen -f -- "$cur") )
    return 0
  fi

  if [[ "$cur" == -* ]]; then
    COMPREPLY=( $(compgen -W "--db --help -h" -- "$cur") )
    return 0
  fi

  return 0
}

# Register with the main Lectic completion engine.
lectic_register_completion task _lectic_complete_task
lectic_register_completion taskboard _lectic_complete_taskboard
