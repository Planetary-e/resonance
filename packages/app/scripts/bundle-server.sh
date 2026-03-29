#!/usr/bin/env bash
# Bundle the Resonance backend for Tauri production builds.
#
# Produces:
#   src-tauri/binaries/node-<triple>       — Node.js binary (sidecar)
#   src-tauri/resources/server/server.mjs  — Bundled server code
#   src-tauri/resources/server/node_modules/  — Native modules only (slim)
#
# Usage: bash scripts/bundle-server.sh

set -euo pipefail
cd "$(dirname "$0")/.."

RESOURCES="src-tauri/resources/server"
BINARIES="src-tauri/binaries"
REPO_ROOT="$(cd ../.. && pwd)"
NM="$REPO_ROOT/node_modules"

# Detect host triple
detect_triple() {
  local os arch
  os="$(uname -s)"
  arch="$(uname -m)"
  case "$os" in
    Darwin)
      case "$arch" in
        arm64) echo "aarch64-apple-darwin" ;;
        x86_64) echo "x86_64-apple-darwin" ;;
      esac ;;
    Linux)
      case "$arch" in
        x86_64) echo "x86_64-unknown-linux-gnu" ;;
        aarch64) echo "aarch64-unknown-linux-gnu" ;;
      esac ;;
    MINGW*|MSYS*|CYGWIN*)
      echo "x86_64-pc-windows-msvc" ;;
  esac
}

TARGET="$(detect_triple)"
echo "==> Bundling server for target: $TARGET"

# Clean previous build
rm -rf "$RESOURCES"
mkdir -p "$RESOURCES/node_modules" "$BINARIES"

# ── 1. Bundle server TypeScript → single JS file ──
echo "==> Bundling server.mjs..."
npx esbuild src/server/start.ts \
  --bundle \
  --platform=node \
  --format=esm \
  --outfile="$RESOURCES/server.mjs" \
  --external:onnxruntime-node \
  --external:onnxruntime-common \
  --external:sharp \
  --external:@img/* \
  --external:@huggingface/transformers \
  --external:sql.js \
  --external:ws \
  --external:hash-wasm \
  --external:tweetnacl \
  --external:tweetnacl-util \
  --external:protobufjs \
  --external:long \
  --external:flatbuffers \
  --target=node20 \
  2>&1

echo "  server.mjs: $(du -sh "$RESOURCES/server.mjs" | cut -f1)"

# ── 2. Copy runtime modules (slim — no caches, no sources, no types) ──
echo "==> Copying runtime modules..."

copy_slim() {
  local mod="$1"
  local src="$NM/$mod"
  if [ ! -d "$src" ]; then
    echo "  SKIP $mod (not found)"
    return
  fi
  local dest="$RESOURCES/node_modules/$mod"
  mkdir -p "$(dirname "$dest")"
  cp -R "$src" "$dest"

  # Strip caches, source maps, TypeScript sources, docs
  find "$dest" -type d -name ".cache" -exec rm -rf {} + 2>/dev/null || true
  find "$dest" -type d -name "src" -not -path "*/dist/*" -exec rm -rf {} + 2>/dev/null || true
  find "$dest" -type d -name "types" -exec rm -rf {} + 2>/dev/null || true
  find "$dest" -type d -name "test" -exec rm -rf {} + 2>/dev/null || true
  find "$dest" -type d -name "tests" -exec rm -rf {} + 2>/dev/null || true
  find "$dest" -type d -name "docs" -exec rm -rf {} + 2>/dev/null || true
  find "$dest" -type d -name "__tests__" -exec rm -rf {} + 2>/dev/null || true
  find "$dest" -name "*.map" -delete 2>/dev/null || true
  find "$dest" -name "*.ts" -not -name "*.d.ts" -delete 2>/dev/null || true
  find "$dest" -name "CHANGELOG*" -delete 2>/dev/null || true
  find "$dest" -name "README*" -delete 2>/dev/null || true
  find "$dest" -name "LICENSE*" -delete 2>/dev/null || true

  echo "  + $mod ($(du -sh "$dest" | cut -f1))"
}

# Core native modules
copy_slim "onnxruntime-node"
copy_slim "onnxruntime-common"
copy_slim "@huggingface/transformers"
copy_slim "sharp"
copy_slim "@img/sharp-darwin-arm64"
copy_slim "@img/sharp-darwin-x64"
copy_slim "@img/sharp-linux-x64"
copy_slim "@img/sharp-win32-x64"

# Pure JS dependencies that are externalized
copy_slim "sql.js"
copy_slim "ws"
copy_slim "hash-wasm"
copy_slim "tweetnacl"
copy_slim "tweetnacl-util"
copy_slim "protobufjs"
copy_slim "long"
copy_slim "flatbuffers"

# Strip ONNX runtime binaries for other platforms to save space
echo "==> Stripping non-target platform binaries..."
case "$TARGET" in
  aarch64-apple-darwin)
    rm -rf "$RESOURCES/node_modules/onnxruntime-node/bin/napi-v3/linux" 2>/dev/null
    rm -rf "$RESOURCES/node_modules/onnxruntime-node/bin/napi-v3/win32" 2>/dev/null
    rm -rf "$RESOURCES/node_modules/@img/sharp-linux-x64" 2>/dev/null
    rm -rf "$RESOURCES/node_modules/@img/sharp-win32-x64" 2>/dev/null
    rm -rf "$RESOURCES/node_modules/@img/sharp-darwin-x64" 2>/dev/null
    ;;
  x86_64-apple-darwin)
    rm -rf "$RESOURCES/node_modules/onnxruntime-node/bin/napi-v3/linux" 2>/dev/null
    rm -rf "$RESOURCES/node_modules/onnxruntime-node/bin/napi-v3/win32" 2>/dev/null
    rm -rf "$RESOURCES/node_modules/@img/sharp-linux-x64" 2>/dev/null
    rm -rf "$RESOURCES/node_modules/@img/sharp-win32-x64" 2>/dev/null
    rm -rf "$RESOURCES/node_modules/@img/sharp-darwin-arm64" 2>/dev/null
    ;;
  x86_64-unknown-linux-gnu)
    rm -rf "$RESOURCES/node_modules/onnxruntime-node/bin/napi-v3/darwin" 2>/dev/null
    rm -rf "$RESOURCES/node_modules/onnxruntime-node/bin/napi-v3/win32" 2>/dev/null
    rm -rf "$RESOURCES/node_modules/@img/sharp-darwin-arm64" 2>/dev/null
    rm -rf "$RESOURCES/node_modules/@img/sharp-darwin-x64" 2>/dev/null
    rm -rf "$RESOURCES/node_modules/@img/sharp-win32-x64" 2>/dev/null
    ;;
  x86_64-pc-windows-msvc)
    rm -rf "$RESOURCES/node_modules/onnxruntime-node/bin/napi-v3/darwin" 2>/dev/null
    rm -rf "$RESOURCES/node_modules/onnxruntime-node/bin/napi-v3/linux" 2>/dev/null
    rm -rf "$RESOURCES/node_modules/@img/sharp-darwin-arm64" 2>/dev/null
    rm -rf "$RESOURCES/node_modules/@img/sharp-darwin-x64" 2>/dev/null
    rm -rf "$RESOURCES/node_modules/@img/sharp-linux-x64" 2>/dev/null
    ;;
esac

echo "  node_modules total: $(du -sh "$RESOURCES/node_modules" | cut -f1)"

# ── 3. Copy Node.js binary as Tauri sidecar ──
NODE_BIN="$(realpath "$(which node)")"
SIDECAR_NAME="node-$TARGET"
if [[ "$TARGET" == *windows* ]]; then
  SIDECAR_NAME="$SIDECAR_NAME.exe"
fi

echo "==> Copying Node.js binary..."
rm -f "$BINARIES/$SIDECAR_NAME" 2>/dev/null || true
cp "$NODE_BIN" "$BINARIES/$SIDECAR_NAME"
chmod +x "$BINARIES/$SIDECAR_NAME"
echo "  $SIDECAR_NAME: $(du -sh "$BINARIES/$SIDECAR_NAME" | cut -f1)"

# ── 4. Summary ──
TOTAL=$(du -sh "$RESOURCES" "$BINARIES" | awk '{sum+=$1} END{print sum"M"}')
echo ""
echo "=== Bundle complete ==="
echo "  Server:    $RESOURCES/server.mjs ($(du -sh "$RESOURCES/server.mjs" | cut -f1))"
echo "  Modules:   $RESOURCES/node_modules/ ($(du -sh "$RESOURCES/node_modules" | cut -f1))"
echo "  Sidecar:   $BINARIES/$SIDECAR_NAME ($(du -sh "$BINARIES/$SIDECAR_NAME" | cut -f1))"
echo "  Total resources: $(du -sh "$RESOURCES" | cut -f1)"
