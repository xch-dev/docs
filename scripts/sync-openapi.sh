#!/usr/bin/env bash
# Regenerates src/openapi.json from a Sage release.
#
# Usage: pnpm sync-openapi [tag]
#   tag defaults to the latest Sage release. Set SAGE_DIR to use an existing
#   Sage checkout instead of cloning one. Requires git and a Rust toolchain.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
tag="${1:-}"

if [[ -z "$tag" && -z "${SAGE_DIR:-}" ]]; then
  tag="$(git ls-remote --tags --refs --sort=-v:refname https://github.com/xch-dev/sage 'v*' \
    | head -n 1 | sed 's#.*refs/tags/##')"
fi

if [[ -n "${SAGE_DIR:-}" ]]; then
  sage="$SAGE_DIR"
else
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT
  sage="$tmp/sage"
  echo "Cloning Sage $tag..."
  git clone --quiet --depth 1 --branch "$tag" https://github.com/xch-dev/sage "$sage"
fi

echo "Generating OpenAPI spec..."
(cd "$sage" && cargo run --quiet --release --bin sage -- rpc generate_openapi -o "$root/src/openapi.json")

echo "Updated src/openapi.json to $(node -p "require('$root/src/openapi.json').info.version")"
