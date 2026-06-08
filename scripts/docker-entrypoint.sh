#!/bin/sh
set -e

if ! command -v claude >/dev/null 2>&1; then
  echo "tabterm: installing Claude Code CLI..."
  curl -fsSL https://claude.ai/install.sh | sh
fi

exec tabterm "$@"
