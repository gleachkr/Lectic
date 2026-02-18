# Bash completion for Lectic.
#
# Intended to be sourced from ~/.bashrc or ~/.bash_profile, e.g.
#
#   source /path/to/lectic_bash_completion.bash
#
# This script discovers subcommands and loads optional completion plugins at
# source-time. Subcommand discovery matches runtime behavior:
#
# - If LECTIC_RUNTIME is set: recursively scan each directory in it first
# - Then recursively scan LECTIC_CONFIG and LECTIC_DATA
# - PATH dirs are always scanned top-level only
#
# Completion plugins
#
# Users can provide custom completion functions for custom subcommands.
# A plugin is just a bash file that calls:
#
#   lectic_register_completion <subcommand> <function_name>
#
# Plugins are loaded from:
#
#   <root>/completions/*.bash for each recursive discovery root
#
# Recursive roots are:
# - entries in LECTIC_RUNTIME first, if set
# - then LECTIC_CONFIG and LECTIC_DATA (with XDG defaults)
#
# ...and may also be placed next to a custom subcommand executable as:
#
#   lectic-<cmd>.completion.bash
#
# This keeps tab completion low-latency because no subprocesses are
# started when the user presses TAB.

if [[ -n "${__LECTIC_BASH_COMPLETION_LOADED:-}" ]]; then
  return 0
fi
__LECTIC_BASH_COMPLETION_LOADED=1

__LECTIC_XDG_CONFIG_HOME="${XDG_CONFIG_HOME:-${HOME}/.config}"
__LECTIC_XDG_DATA_HOME="${XDG_DATA_HOME:-${HOME}/.local/share}"

__LECTIC_CONFIG_DIR="${LECTIC_CONFIG:-${__LECTIC_XDG_CONFIG_HOME}/lectic}"
__LECTIC_DATA_DIR="${LECTIC_DATA:-${__LECTIC_XDG_DATA_HOME}/lectic}"

__LECTIC_SUBCOMMAND_SET=""
__LECTIC_SUBCOMMANDS=()

__lectic_add_subcommand() {
  local cmd="$1"

  case " ${__LECTIC_SUBCOMMAND_SET} " in
    *" ${cmd} "*)
      return 1
      ;;
  esac

  __LECTIC_SUBCOMMAND_SET+=" ${cmd}"
  __LECTIC_SUBCOMMANDS+=("${cmd}")
  return 0
}

__lectic_source_adjacent_completion() {
  local cmd_path="$1"
  local base cmd_name
  cmd_name="$(basename "${cmd_path}")"

  base="$(dirname "$cmd_path")/${cmd_name%%.*}"

  if [[ -f "${base}.completion.bash" ]]; then
    # shellcheck source=/dev/null
    source "${base}.completion.bash"
  fi
}

__lectic_sanitize_key() {
  local key="$1"
  key="${key//[^a-zA-Z0-9_]/_}"
  printf %s "${key}"
}

lectic_register_completion() {
  local subcommand="$1"
  local fn="$2"
  local key

  key="$(__lectic_sanitize_key "${subcommand}")"
  eval "__LECTIC_COMPLETE_FN_KEY_${key}=\"${fn}\""
}

__lectic_get_completion() {
  local subcommand="$1"
  local key

  key="$(__lectic_sanitize_key "${subcommand}")"
  eval "printf %s \"\${__LECTIC_COMPLETE_FN_KEY_${key}:-}\""
}

__lectic_register_subcommand_path() {
  local cmd_path="$1"
  local cmd_name

  [[ -f "${cmd_path}" && -x "${cmd_path}" ]] || return 0

  cmd_name=$(basename "${cmd_path}")
  cmd_name="${cmd_name#lectic-}"
  cmd_name="${cmd_name%%.*}"

  if __lectic_add_subcommand "${cmd_name}"; then
    __lectic_source_adjacent_completion "${cmd_path}"
  fi
}

__lectic_scan_recursive_subcommands() {
  local root="$1"
  local cmd_path

  [[ -d "${root}" ]] || return 0

  while IFS= read -r -d '' cmd_path; do
    __lectic_register_subcommand_path "${cmd_path}"
  done < <(
    find -L "${root}" -type f -name 'lectic-*' -perm -u+x -print0 2>/dev/null
  )
}

__lectic_collect_recursive_roots() {
  __LECTIC_RECURSIVE_ROOTS=()

  if [[ -v LECTIC_RUNTIME ]]; then
    local runtime_dirs=()
    local dir

    IFS=':' read -r -a runtime_dirs <<< "${LECTIC_RUNTIME}"
    for dir in "${runtime_dirs[@]}"; do
      [[ -n "${dir}" ]] || continue
      __LECTIC_RECURSIVE_ROOTS+=("${dir}")
    done
  fi

  __LECTIC_RECURSIVE_ROOTS+=("${__LECTIC_CONFIG_DIR}")
  __LECTIC_RECURSIVE_ROOTS+=("${__LECTIC_DATA_DIR}")
}

__lectic_init_subcommands() {
  local core_subcommands=(models parse lsp script)
  local path_dirs=()
  local dir cmd_path
  local old_nullglob

  for dir in "${core_subcommands[@]}"; do
    __lectic_add_subcommand "${dir}"
  done

  old_nullglob=$(shopt -p nullglob)
  shopt -s nullglob

  __lectic_collect_recursive_roots

  # 1) Recursive discovery roots:
  #    - LECTIC_RUNTIME entries first if set
  #    - then LECTIC_CONFIG and LECTIC_DATA
  for dir in "${__LECTIC_RECURSIVE_ROOTS[@]}"; do
    __lectic_scan_recursive_subcommands "${dir}"
  done

  # 2) PATH entries: top-level only.
  IFS=':' read -r -a path_dirs <<< "${PATH}"
  for dir in "${path_dirs[@]}"; do
    [[ -d "${dir}" ]] || continue
    for cmd_path in "${dir}"/lectic-*; do
      __lectic_register_subcommand_path "${cmd_path}"
    done
  done

  eval "${old_nullglob}"
}

__lectic_source_completion_plugins() {
  local completion_dirs=()
  local dir f
  local old_nullglob

  __lectic_collect_recursive_roots

  for dir in "${__LECTIC_RECURSIVE_ROOTS[@]}"; do
    completion_dirs+=("${dir}/completions")
  done

  old_nullglob=$(shopt -p nullglob)
  shopt -s nullglob

  for dir in "${completion_dirs[@]}"; do
    [[ -d "${dir}" ]] || continue

    for f in "${dir}"/*.bash; do
      [[ -f "${f}" ]] || continue
      # shellcheck source=/dev/null
      source "${f}"
    done
  done

  eval "${old_nullglob}"
}

__lectic_init_subcommands
__lectic_source_completion_plugins

_lectic_complete() {
  local cur
  cur="${COMP_WORDS[COMP_CWORD]}"
  COMPREPLY=()

  # Find the subcommand position, accounting for global options.
  # This is a best-effort parser for the most common shapes:
  #
  #   lectic <subcommand>
  #   lectic -q <subcommand>
  #   lectic --file path <subcommand>
  local i word
  local subcmd_idx=""

  i=1
  while (( i < ${#COMP_WORDS[@]} )); do
    word="${COMP_WORDS[i]}"

    case "${word}" in
      -f|--file|-i|--inplace|-l|--log)
        ((i++))
        ;;
      --file=*|--inplace=*|--log=*)
        ;;
      --)
        ((i++))
        break
        ;;
      -* )
        ;;
      * )
        subcmd_idx="${i}"
        break
        ;;
    esac

    ((i++))
  done

  if [[ -z "${subcmd_idx}" ]]; then
    # No subcommand yet. Offer global options and known subcommands.
    local global_opts
    global_opts="-s --short -S --Short -f --file -i --inplace -l --log "
    global_opts+="-q --quiet -v --version -h --help"

    if [[ "${cur}" == -* ]]; then
      COMPREPLY=( $(compgen -W "${global_opts}" -- "${cur}") )
      return 0
    fi

    if (( COMP_CWORD == 1 )); then
      COMPREPLY=( $(compgen -W "${__LECTIC_SUBCOMMANDS[*]}" -- "${cur}") )
      return 0
    fi

    return 0
  fi

  if (( COMP_CWORD == subcmd_idx )); then
    COMPREPLY=( $(compgen -W "${__LECTIC_SUBCOMMANDS[*]}" -- "${cur}") )
    return 0
  fi

  local subcommand
  subcommand="${COMP_WORDS[subcmd_idx]}"

  local fn
  fn="$(__lectic_get_completion "${subcommand}")"

  if [[ -n "${fn}" ]] && declare -F "${fn}" >/dev/null 2>&1; then
    "${fn}"
    return $?
  fi

  return 0
}

complete -F _lectic_complete lectic
