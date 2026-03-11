#!/usr/bin/env bash
set -euo pipefail

arg="${ARG:-}"
context="${TODO_CONTEXT:-2}"

if [[ -z "$arg" ]]; then
  echo ":todo[] requires a completion item or path:line argument" >&2
  exit 1
fi

if [[ ! "$context" =~ ^[0-9]+$ ]]; then
  echo "TODO_CONTEXT must be an integer" >&2
  exit 1
fi

location="$arg"
if [[ "$location" == *" — "* ]]; then
  location="${location##* — }"
fi

path="${location%:*}"
line="${location##*:}"

if [[ -z "$path" || -z "$line" || ! "$line" =~ ^[0-9]+$ ]]; then
  echo "Could not parse TODO location from: $arg" >&2
  exit 1
fi

if [[ ! -f "$path" ]]; then
  echo "TODO target does not exist: $path" >&2
  exit 1
fi

start=$(( line - context ))
if (( start < 1 )); then
  start=1
fi

total_lines="$(awk 'END { print NR }' "$path")"
if [[ -z "$total_lines" ]]; then
  total_lines=0
fi

if (( total_lines == 0 )); then
  echo "TODO target is empty: $path" >&2
  exit 1
fi

end=$(( line + context ))
if (( end > total_lines )); then
  end=$total_lines
fi

if (( line > total_lines )); then
  echo "TODO line $line is outside $path" >&2
  exit 1
fi

infer_lang() {
  local file="$1"
  local base ext
  base="$(basename "$file")"

  case "$base" in
    Dockerfile)
      printf 'dockerfile'
      return
      ;;
  esac

  ext="${file##*.}"
  case "$ext" in
    ts|cts|mts) printf 'ts' ;;
    tsx) printf 'tsx' ;;
    js|cjs|mjs) printf 'js' ;;
    jsx) printf 'jsx' ;;
    py) printf 'python' ;;
    rb) printf 'ruby' ;;
    sh|bash) printf 'bash' ;;
    zsh) printf 'zsh' ;;
    fish) printf 'fish' ;;
    yml|yaml) printf 'yaml' ;;
    json) printf 'json' ;;
    md|qmd) printf 'markdown' ;;
    lua) printf 'lua' ;;
    rs) printf 'rust' ;;
    go) printf 'go' ;;
    java) printf 'java' ;;
    kt|kts) printf 'kotlin' ;;
    swift) printf 'swift' ;;
    c|h) printf 'c' ;;
    cc|cpp|cxx|hpp|hh|hxx) printf 'cpp' ;;
    css) printf 'css' ;;
    scss) printf 'scss' ;;
    html|htm) printf 'html' ;;
    xml) printf 'xml' ;;
    sql) printf 'sql' ;;
    toml) printf 'toml' ;;
    ini|conf) printf 'ini' ;;
    nix) printf 'nix' ;;
    *) printf '' ;;
  esac
}

lang="$(infer_lang "$path")"

printf 'TODO from `%s` lines %d-%d (TODO at line %d):\n\n' \
  "$path" "$start" "$end" "$line"
printf '```%s\n' "$lang"
sed -n "${start},${end}p" "$path"
printf '```\n'
