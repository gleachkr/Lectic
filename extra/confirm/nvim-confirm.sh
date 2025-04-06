#!/bin/bash

sleep infinity & SLEEPPID=$!

trap 'kill $SLEEPPID; exit 0' USR1

if [ -z ${NVIM+x} ]; then exit 1; fi

NAME=${1//\"/\\\"}
NAME=${NAME//$'\n'/\\n}
ARGS=${2//\"/\\\"}
ARGS=${ARGS//$'\n'/\\n}

LUACMD1=$(cat <<LUA
vim.notify("An LLM is attempting to use tool $NAME with arguments $ARGS")
LUA
)

LUACMD2=$(cat <<LUA
vim.ui.select({"allow","deny"},{ prompt="Allow use of $NAME?" }, function(choice) if choice=="allow" then vim.uv.kill($$,"sigusr1") else vim.uv.kill($$) end end)
LUA
)

echo "$LUACMD"

nvim --server "$NVIM" --headless --remote-expr "luaeval('$LUACMD1')"
nvim --server "$NVIM" --headless --remote-expr "luaeval('$LUACMD2')"

wait
