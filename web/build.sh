#!/bin/sh
# Concatenate the sources into one self-contained page, served by GitHub Pages from docs/:
# https://zeblawrence.github.io/interactive-backgrounds/
cd "$(dirname "$0")"
cat src/00-head.html src/0[1-8]-*.js src/99-tail.html > ../docs/index.html
echo "wrote docs/index.html ($(wc -c < ../docs/index.html) bytes)"
