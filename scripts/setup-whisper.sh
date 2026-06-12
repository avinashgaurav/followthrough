#!/usr/bin/env bash
# Followthrough local STT setup: whisper.cpp + ffmpeg + ggml-large-v3-turbo model.
# Idempotent: safe to re-run. Never uses sudo. Audio stays on this machine.
set -euo pipefail

MODEL_DIR="${HOME}/.cache/whisper"
MODEL_PATH="${MODEL_DIR}/ggml-large-v3-turbo.bin"
MODEL_URL="https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo.bin"

if ! command -v brew >/dev/null 2>&1; then
  echo "error: Homebrew not found. Install it from https://brew.sh and re-run this script." >&2
  echo "       (This script never uses sudo, so it will not install Homebrew for you.)" >&2
  exit 1
fi

ensure_formula() {
  local formula="$1" probe="$2"
  if command -v "$probe" >/dev/null 2>&1; then
    echo "ok: ${probe} already on PATH ($(command -v "$probe"))"
  elif brew list --formula "$formula" >/dev/null 2>&1; then
    echo "ok: ${formula} already installed via Homebrew"
  else
    echo "installing ${formula} via Homebrew..."
    brew install "$formula"
  fi
}

ensure_formula whisper-cpp whisper-cli
ensure_formula ffmpeg ffmpeg

mkdir -p "$MODEL_DIR"

if [ -f "$MODEL_PATH" ]; then
  echo "ok: model already present at ${MODEL_PATH}"
else
  echo "downloading ggml-large-v3-turbo.bin (~1.6 GB) to ${MODEL_PATH}..."
  curl -L --fail --progress-bar -o "${MODEL_PATH}.part" "$MODEL_URL"
  mv "${MODEL_PATH}.part" "$MODEL_PATH"
  echo "ok: model downloaded"
fi

# Resolve the whisper binary the same way the app does:
# WHISPER_CPP_PATH override first, then known CLI names on PATH.
WHISPER_BIN="${WHISPER_CPP_PATH:-}"
if [ -z "$WHISPER_BIN" ]; then
  for name in whisper-cli whisper-cpp whisper; do
    if command -v "$name" >/dev/null 2>&1; then
      WHISPER_BIN="$(command -v "$name")"
      break
    fi
  done
fi
if [ -z "$WHISPER_BIN" ]; then
  echo "error: whisper.cpp binary still not found after install. Check 'brew info whisper-cpp'." >&2
  exit 1
fi

FFMPEG_BIN="$(command -v ffmpeg)"

echo ""
echo "Local STT is ready."
echo "  whisper binary: ${WHISPER_BIN}"
echo "  ffmpeg binary:  ${FFMPEG_BIN}"
echo "  model:          ${MODEL_PATH}"
echo ""
echo "Add these lines to your .env (or shell profile):"
echo "export WHISPER_CPP_PATH=${WHISPER_BIN}"
echo "export WHISPER_MODEL_PATH=${MODEL_PATH}"
