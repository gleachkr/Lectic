#!/bin/bash

mkdir -p sandbox
bwrap --ro-bind / / --dev /dev --bind sandbox "$HOME" "$@"
