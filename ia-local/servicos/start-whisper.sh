#!/usr/bin/env bash
# Whisper local (fork ia-local do Excalidraw, fase 4b): transcrição de voz na CPU.
# A GPU fica para o Qwen. Medido: large-v3 q5_0, 8 threads, ~6,7 s por pedido.
set -euo pipefail
MODEL="${WHISPER_MODEL:-$HOME/tools/models/whisper/ggml-large-v3-q5_0.bin}"
THREADS="${WHISPER_THREADS:-8}"
PORT="${WHISPER_PORT:-9932}"
exec "$HOME/tools/whisper.cpp/build/bin/whisper-server" \
  --host 127.0.0.1 --port "$PORT" \
  -m "$MODEL" -t "$THREADS" \
  -l pt -nt -bs 1 -bo 1
