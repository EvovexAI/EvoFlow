#!/bin/bash
# Build whisper_server.py into a standalone directory using PyInstaller.
# Output: whisper-dist/ at backend root.
#
# Prerequisites:
#   pip install pyinstaller openai-whisper websockets numpy tiktoken
#
# Usage:
#   bash backend/packaging/macos/build-whisper.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BACKEND_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
VOICE_DIR="$BACKEND_ROOT/app/gateway/speech"
DIST_DIR="$BACKEND_ROOT/whisper-dist"

echo "[build-whisper] Installing PyInstaller and deps..."
pip install pyinstaller openai-whisper websockets numpy tiktoken --quiet

echo "[build-whisper] Running PyInstaller (this takes a few minutes)..."
cd "$VOICE_DIR"

pyinstaller \
    --noconfirm \
    --clean \
    --onedir \
    --name whisper_server \
    --collect-all whisper \
    --collect-all tiktoken \
    --hidden-import "websockets.server" \
    --hidden-import "websockets.legacy" \
    --hidden-import "websockets.legacy.server" \
    --hidden-import "tiktoken_ext" \
    --hidden-import "tiktoken_ext.openai_public" \
    --hidden-import "tqdm" \
    --hidden-import "tqdm.auto" \
    --hidden-import "numpy" \
    --hidden-import "numpy.core._methods" \
    --exclude-module "matplotlib" \
    --exclude-module "PIL" \
    --exclude-module "IPython" \
    --exclude-module "tensorflow" \
    --exclude-module "jupyter" \
    --exclude-module "notebook" \
    whisper_server.py

echo "[build-whisper] Moving output to whisper-dist/..."
rm -rf "$DIST_DIR"
mv "$VOICE_DIR/dist/whisper_server" "$DIST_DIR"

# Copy cached models if available
MODEL_DIR="$BACKEND_ROOT/data/whisper-models"
if [ -d "$MODEL_DIR" ]; then
    cp -R "$MODEL_DIR" "$DIST_DIR/models"
    echo "[build-whisper] Whisper models copied from cache"
fi

# Cleanup
rm -rf "$VOICE_DIR/build" "$VOICE_DIR/dist" "$VOICE_DIR/whisper_server.spec"

echo ""
echo "================================================"
echo "[build-whisper] Done!"
echo "  Output: $DIST_DIR"
echo "  Binary: $DIST_DIR/whisper_server"
echo ""
echo "  To use: ./whisper_server --model small"
echo "  First run will auto-download model (~1-3GB) if not cached."
echo "================================================"
