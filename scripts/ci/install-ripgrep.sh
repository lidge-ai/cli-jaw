#!/usr/bin/env bash
set -euo pipefail

RG_VERSION=15.2.0
RG_ASSET="ripgrep-${RG_VERSION}-x86_64-unknown-linux-musl.tar.gz"
RG_SHA256=33e15bcf1624b25cdd2a55813a47a2f95dbe126268203e76aa6a585d1e7b149c

if [ "$(uname -s)" != "Linux" ]; then
  echo "ERROR: install-ripgrep.sh only supports Linux (got $(uname -s))" >&2
  exit 2
fi

if [ "$(uname -m)" != "x86_64" ]; then
  echo "ERROR: install-ripgrep.sh only supports x86_64 (got $(uname -m))" >&2
  exit 2
fi

DEST="${DEST:-${RUNNER_TEMP:-$(mktemp -d)}/ripgrep-bin}"
TMPDIR="${RUNNER_TEMP:-$(mktemp -d)}"

mkdir -p "$DEST"

cd "$TMPDIR"
curl -fsSL --retry 3 "https://github.com/BurntSushi/ripgrep/releases/download/${RG_VERSION}/${RG_ASSET}" -o "$RG_ASSET"
echo "${RG_SHA256}  ${RG_ASSET}" | sha256sum -c -

tar -xzf "$RG_ASSET"
cp "ripgrep-${RG_VERSION}-x86_64-unknown-linux-musl/rg" "${DEST}/rg"
chmod +x "${DEST}/rg"

if [ -n "${GITHUB_PATH:-}" ]; then
  echo "$DEST" >> "$GITHUB_PATH"
fi

"${DEST}/rg" --version
