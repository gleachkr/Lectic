#!/bin/bash

if [ -z "$1" ]; then
    echo "Error: no argument provided"
    exit 1
fi

if ! command -v bwrap; then
    echo "Error: bwrap needs to be installed to use this sandbox"
    exit 1
fi

if [ -d "$1" ]; then
    remaining_args=("${@:2}")
    bwrap --ro-bind / / --dev /dev --bind "$(realpath "$1")" "$(realpath "$1")" "${remaining_args[@]}"
else 
    bwrap --ro-bind / / --dev /dev --bind "$PWD" "$PWD" "$@"
fi
