#!/bin/sh
set -eu
ROOT="$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)"
VERSION="$(cd "$ROOT" && node --input-type=module -e "import('./src/version.js').then((m) => process.stdout.write(m.VERSION))")"
OUT="${1:-$ROOT/dist}"
STAGE="$OUT/vllm-cc-tools-proxy-v$VERSION"
rm -rf "$STAGE"
mkdir -p "$STAGE"
(
  cd "$ROOT"
  tar --exclude=.git --exclude=dist --exclude=node_modules --exclude='*.log' -cf - .
) | (cd "$STAGE" && tar -xf -)
(cd "$STAGE" && ./scripts/verify.sh)
mkdir -p "$OUT"
(cd "$STAGE" && find . -type f ! -name MANIFEST.sha256 -print0 | sort -z | xargs -0 sha256sum > MANIFEST.sha256)
(cd "$STAGE" && zip -qr "$OUT/vllm-cc-tools-proxy-v$VERSION.zip" .)
sha256sum "$OUT/vllm-cc-tools-proxy-v$VERSION.zip" > "$OUT/vllm-cc-tools-proxy-v$VERSION.zip.sha256"
echo "$OUT/vllm-cc-tools-proxy-v$VERSION.zip"
