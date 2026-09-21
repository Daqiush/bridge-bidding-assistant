#!/usr/bin/env bash
set -euo pipefail
root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
rm -rf "$root/dist"
mkdir -p "$root/dist/server" "$root/dist/.openai"
cp "$root/worker/index.js" "$root/dist/server/index.js"
cp "$root/.openai/hosting.json" "$root/dist/.openai/hosting.json"
echo "Built $root/dist"
