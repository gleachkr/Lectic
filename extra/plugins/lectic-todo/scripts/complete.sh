#!/usr/bin/env bash
set -euo pipefail

if ! command -v rg >/dev/null 2>&1; then
  echo "rg is required for :todo[] completions" >&2
  exit 1
fi

limit="${TODO_MAX_RESULTS:-200}"
pattern="${TODO_PATTERN:-\\bTODO\\b}"
completion_context="${TODO_COMPLETION_CONTEXT:-1}"
timeout_seconds="${TODO_RG_TIMEOUT_SECONDS:-2}"
rg_out="$(mktemp)"
rg_err="$(mktemp)"

cleanup() {
  rm -f "$rg_out" "$rg_err"
}
trap cleanup EXIT

yaml_quote() {
  local value="${1//$'\r'/}"
  value="${value//$'\n'/ }"
  value="${value//\'/\'\'}"
  printf "'%s'" "$value"
}

trim_inline() {
  local value="$1"
  value="${value//$'\t'/ }"
  value="$(printf '%s' "$value" \
    | sed -E 's/[[:space:]]+/ /g; s/^ //; s/ $//')"
  printf '%s' "$value"
}

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

print_documentation() {
  local file="$1"
  local line="$2"
  local context="$3"
  local total_lines start end lang

  total_lines="$(awk 'END { print NR }' "$file")"
  if [[ -z "$total_lines" || "$total_lines" -eq 0 ]]; then
    return
  fi

  start=$(( line - context ))
  if (( start < 1 )); then
    start=1
  fi

  end=$(( line + context ))
  if (( end > total_lines )); then
    end=$total_lines
  fi

  lang="$(infer_lang "$file")"

  printf '  detail: %s\n' \
    "$(yaml_quote "$file lines $start-$end (TODO at $line)")"
  printf '  documentation: |\n'
  printf '    %s lines %d-%d (TODO at %d)\n' \
    "$file" "$start" "$end" "$line"
  printf '    \n'
  printf '    ```%s\n' "$lang"
  sed -n "${start},${end}p" "$file" | sed 's/^/    /'
  printf '    ```\n'
}

run_rg() {
  rg \
    -0 \
    --line-number \
    --column \
    --no-require-git \
    --no-heading \
    --color=never \
    --smart-case \
    --glob '!.git/**' \
    --glob '!node_modules/**' \
    --glob '!dist/**' \
    --glob '!build/**' \
    --glob '!.next/**' \
    --glob '!coverage/**' \
    --glob '!target/**' \
    "$pattern" \
    . >"$rg_out" 2>"$rg_err" &
  local rg_pid=$!

  (
    sleep "$timeout_seconds"
    if kill -0 "$rg_pid" 2>/dev/null; then
      kill "$rg_pid" 2>/dev/null || true
      sleep 0.1
      kill -9 "$rg_pid" 2>/dev/null || true
    fi
  ) &
  local watchdog_pid=$!
  local status

  set +e
  wait "$rg_pid"
  status=$?
  set -e

  kill "$watchdog_pid" 2>/dev/null || true
  wait "$watchdog_pid" 2>/dev/null || true

  if [[ "$status" -eq 143 || "$status" -eq 137 ]]; then
    echo "rg timed out after ${timeout_seconds}s" >&2
    return 124
  fi

  return "$status"
}

count=0
printed_any=0
rg_status=0

if run_rg; then
  rg_status=0
else
  rg_status=$?
fi

while IFS= read -r -d '' file && IFS= read -r rest; do
  file="${file#./}"
  line="${rest%%:*}"
  remainder="${rest#*:}"
  text="${remainder#*:}"
  text="$(trim_inline "$text")"
  location="$file:$line"

  if [[ -z "$text" ]]; then
    text="TODO"
  fi

  if (( ${#text} > 140 )); then
    text="${text:0:137}..."
  fi

  completion="$text — $location"

  printf -- "- completion: %s\n" "$(yaml_quote "$completion")"
  print_documentation "$file" "$line" "$completion_context"

  printed_any=1
  ((count += 1))
  if (( count >= limit )); then
    break
  fi
done < "$rg_out"

if (( rg_status != 0 && rg_status != 1 && rg_status != 124 )); then
  cat "$rg_err" >&2
fi

if (( printed_any == 0 )); then
  printf '[]\n'
fi
