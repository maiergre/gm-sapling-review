#!/usr/bin/env bash
set -euo pipefail

# Work from the project directory even when invoked from elsewhere.
cd -- "$(dirname -- "${BASH_SOURCE[0]}")"

for tool in node npm code; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    printf 'Required command not found on PATH: %s\n' "$tool" >&2
    exit 1
  fi
done

npm run package

vsix=$(node -p 'const p = require("./package.json"); `${p.name}-${p.version}.vsix`')
if [[ ! -f "$vsix" ]]; then
  printf 'Package was not created: %s\n' "$vsix" >&2
  exit 1
fi

code --install-extension "$vsix" --force
printf 'Installed %s. Run Developer: Reload Window in VS Code.\n' "$vsix"
