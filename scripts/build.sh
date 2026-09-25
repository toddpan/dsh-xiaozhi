#!/bin/bash
# Build: compile src/ -> lib/ with the dsh checkout's tsc.
# Requires DSH_CHECKOUT pointing at a dsh source checkout (auto-probe below).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# DSH_CHECKOUT probe: env var -> common paths
CHECKOUT="${DSH_CHECKOUT:-}"
if [ -z "$CHECKOUT" ]; then
  for candidate in "/Users/tsbj/feyanggit/deepseek-harness" "$HOME/deepseek-harness" "$HOME/feyanggit/deepseek-harness" "$HOME/dsh-harness" "$HOME/dsh" "$HOME/.dsh/dsh-harness"; do
    if [ -d "$candidate/packages" ]; then CHECKOUT="$candidate"; break; fi
  done
fi
if [ -z "$CHECKOUT" ] || [ ! -d "$CHECKOUT/packages" ]; then
  echo "build: cannot locate the dsh checkout (set DSH_CHECKOUT)" >&2
  exit 1
fi

TSC="$CHECKOUT/node_modules/.bin/tsc"
if [ ! -x "$TSC" ] && [ ! -f "$TSC.cmd" ]; then
  echo "build: tsc not found at $TSC" >&2
  exit 1
fi

link_pkg() {
  local target="$CHECKOUT/$2"
  if [ ! -e "$target" ]; then
    echo "build: dependency target missing: $target" >&2
    exit 1
  fi
  node -e "
    const fs = require('fs');
    const path = require('path');
    const link = path.resolve(process.argv[1]);
    const target = path.resolve(process.argv[2]);
    fs.rmSync(link, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(link), { recursive: true });
    fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
  " "node_modules/$1" "$target"
}

echo "=== Linking build dependencies (checkout: $CHECKOUT) ==="
mkdir -p node_modules/@deepseek-ai
node -e "const fs=require('fs');fs.rmSync('node_modules/@standard-schema',{recursive:true,force:true})"
# The harness only ships the official scoped names at runtime, so source imports
# must use those too (bare `cordis` / `schemastery` do not resolve in a clean profile).
link_pkg @deepseek-ai/cordis vendor/cordis
link_pkg cosmokit vendor/cosmokit
link_pkg @deepseek-ai/schemastery vendor/schemastery
# Type-only links: the copied dshapi/* modules read the harness `session/event`
# firehose, whose event map is declared by dsh-session (reached through these).
link_pkg @deepseek-ai/dsh-session packages/core/session
link_pkg @deepseek-ai/dsh-agent packages/core/agent
link_pkg @deepseek-ai/dsh-workspace packages/workspace/workspace
link_pkg @deepseek-ai/dsh-tools packages/core/tools
link_pkg @deepseek-ai/dsh-llm packages/llm/llm
link_pkg @deepseek-ai/dsh-host-webserver packages/host/webserver
# @types/node
link_pkg @types/node node_modules/@types/node

# Test-only links. The browser half runs against the DSH module table, but
# test/client.test.mjs server-renders its sections, so it needs a real React.
# React is not hoisted to the checkout root, so resolve it from the pnpm store
# and skip (rather than fail) when absent: the plugin itself does not need it.
link_pnpm() {
  local name="$1"
  local target
  target=$(ls -d "$CHECKOUT"/node_modules/.pnpm/"$name"@*/node_modules/"$name" 2>/dev/null | head -1)
  if [ -z "$target" ]; then
    echo "build: skipping optional test dependency $name (not in the pnpm store)" >&2
    rm -rf "node_modules/$name"
    return 0
  fi
  node -e "
    const fs = require('fs');
    const path = require('path');
    const link = path.resolve(process.argv[1]);
    const target = path.resolve(process.argv[2]);
    fs.rmSync(link, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(link), { recursive: true });
    fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
  " "node_modules/$name" "$target"
}
link_pnpm react
link_pnpm react-dom
# react-dom's own node_modules carries the matching scheduler instance.
link_pnpm scheduler

STD_SCHEMA=$(find "$CHECKOUT/node_modules/.pnpm" -maxdepth 1 -type d -iname '@standard-schema+spec@*' 2>/dev/null | head -1)
if [ -n "$STD_SCHEMA" ]; then
  node -e "
    const fs = require('fs');
    const path = require('path');
    fs.rmSync('node_modules/@standard-schema', { recursive: true, force: true });
    fs.mkdirSync('node_modules/@standard-schema', { recursive: true });
    fs.symlinkSync(path.resolve(process.argv[1]), path.resolve('node_modules/@standard-schema/spec'), process.platform === 'win32' ? 'junction' : 'dir');
  " "$STD_SCHEMA/node_modules/@standard-schema/spec"
fi

echo "=== Cleaning lib ==="
rm -rf lib
echo "=== Compiling src -> lib ==="
"$TSC" -p tsconfig.json
echo "=== Build complete ==="
