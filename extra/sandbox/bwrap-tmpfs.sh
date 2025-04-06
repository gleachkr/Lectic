#!/bin/bash

mkdir -p sandbox
bwrap --ro-bind / / --dev /dev --tmpfs "$HOME" "$@"
