#!/bin/bash

zenity --question --text="$(cat <<QUERY
An LLM is asking to use the $1 tool with the following set of arguments:

<tt>
$2
</tt>

Grant permission?"
QUERY
)"
