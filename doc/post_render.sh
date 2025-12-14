#!/bin/bash

if [ "$QUARTO_PROJECT_RENDER_ALL" = "1" ]; then
    llms_full="_site/llms-full.md"
    rm -f "${llms_full}"
    mv _quarto.yml _quarto.yml.bak
    # need a better way to impose a sensible ordering on these.
    for file in *.qmd **/*.qmd; do
        echo "llms: ${file}"
        quarto render "${file}" --to gfm-raw_html --quiet --no-execute
        generated_file="${file%.qmd}.md"
        cat "$generated_file" >> "${llms_full}"
        rm "$generated_file"
        echo "" >> "${llms_full}"
    done
    mv _quarto.yml.bak _quarto.yml
fi
