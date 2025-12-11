_lectic_complete()
{
    local cur
    COMPREPLY=()
    cur="${COMP_WORDS[COMP_CWORD]}"

    # Core Lectic subcommands
    local core_subcommands="models parse lsp"

    # --- Dynamic subcommand discovery ---
    local custom_subcommands=""
    local lectic_search_dirs=()

    # Determine XDG config and data directories
    # This mirrors lectic's internal logic for XDG Base Directory
    local xdg_config_home="${XDG_CONFIG_HOME:-${HOME}/.config}"
    local xdg_data_home="${XDG_DATA_HOME:-${HOME}/.local/share}"

    lectic_search_dirs+=("${xdg_config_home}/lectic")
    lectic_search_dirs+=("${xdg_data_home}/lectic")

    # Add system PATH directories
    IFS=':' read -ra path_dirs <<< "$PATH"
    for dir in "${path_dirs[@]}"; do
        lectic_search_dirs+=("$dir")
    done

    # Search for lectic- prefixed executables
    for dir in "${lectic_search_dirs[@]}"; do
        if [[ -d "$dir" ]]; then
            # Find files starting with 'lectic-' and are executable
            for cmd_path in "${dir}"/lectic-*; do
                if [[ -f "$cmd_path" && -x "$cmd_path" ]]; then
                    local cmd_name=$(basename "$cmd_path")
                    # Remove 'lectic-' prefix and any extension (e.g., .sh)
                    cmd_name="${cmd_name#lectic-}"
                    cmd_name="${cmd_name%%.*}" # Remove everything after first dot
                    custom_subcommands+=" $cmd_name"
                fi
            done
        fi
    done
    # Remove duplicates and sort
    custom_subcommands=$(echo "${custom_subcommands}" | tr ' ' '\n' | sort -u | tr '\n' ' ')

    # Combine all subcommands
    local all_subcommands="$core_subcommands $custom_subcommands"

    # Complete subcommands if we are after 'lectic' itself
    if [[ ${COMP_CWORD} -eq 1 ]] ; then
        COMPREPLY=( $(compgen -W "${all_subcommands}" -- "${cur}") )
        return 0
    fi
}
complete -F _lectic_complete lectic
