#!/usr/bin/env bash
# Preserve the old preview command while using the shared release driver.
exec "$(dirname "$0")/release.sh" --preview "$@"
