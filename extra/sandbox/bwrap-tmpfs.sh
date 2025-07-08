#!/bin/bash

bwrap --ro-bind / / --dev /dev --tmpfs "$HOME" "$@"
