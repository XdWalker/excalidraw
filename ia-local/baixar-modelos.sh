#!/usr/bin/env bash
# Baixa os modelos locais usados pelas fases 4 (voz) e 5 (rascunho) do fork
# ia-local. Nada disso vai para o git: são arquivos grandes.
#
#   ia-local/baixar-modelos.sh voz      # Whisper base e small (~330 MB) + runtime ONNX
#   ia-local/baixar-modelos.sh voz-servidor  # whisper.cpp + Whisper large-v3 (~1,1 GB), fase 4b
#   ia-local/baixar-modelos.sh visao    # projetor de visão do Qwen3.8-27B (~0,9 GB)
#   ia-local/baixar-modelos.sh tudo
#
# Voz: os arquivos vão para public/models/, que o app serve em /models/ para o
# Whisper rodar no navegador sem internet (transformers.js com
# allowRemoteModels = false).
# Visão: o projetor vai para ~/tools/models/ (ou MODELS_DIR), ao lado do
# modelo do llama-server; veja ia-local/README.md, fase 5, para ligá-lo.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PUBLIC_MODELS="$ROOT/public/models"
MODELS_DIR="${MODELS_DIR:-$HOME/tools/models}"
HF="https://huggingface.co"

baixar() { # url destino
  local url="$1" dest="$2"
  if [ -s "$dest" ]; then
    echo "  já existe: ${dest#$ROOT/}"
    return
  fi
  mkdir -p "$(dirname "$dest")"
  echo "  baixando: ${dest#$ROOT/}"
  curl -fsSL --retry 3 -o "$dest.part" "$url"
  mv "$dest.part" "$dest"
}

whisper() { # nome do modelo (whisper-base, whisper-small)
  local repo="onnx-community/$1" dir="$PUBLIC_MODELS/onnx-community/$1"
  echo "== $repo"
  for f in config.json generation_config.json preprocessor_config.json \
    tokenizer.json tokenizer_config.json special_tokens_map.json \
    added_tokens.json normalizer.json vocab.json merges.txt; do
    baixar "$HF/$repo/resolve/main/$f" "$dir/$f"
  done
  # q8: ~4x menor que o original, qualidade praticamente igual
  for f in encoder_model_quantized.onnx decoder_model_merged_quantized.onnx; do
    baixar "$HF/$repo/resolve/main/onnx/$f" "$dir/onnx/$f"
  done
}

voz() {
  whisper whisper-base
  whisper whisper-small
  # o runtime ONNX (WebAssembly) também servido localmente: por padrão o
  # transformers.js o busca numa CDN
  echo "== onnxruntime-web (WebAssembly)"
  local ort="$ROOT/node_modules/onnxruntime-web/dist"
  if [ ! -d "$ort" ]; then
    echo "  rode 'corepack yarn install' antes" >&2
    exit 1
  fi
  mkdir -p "$PUBLIC_MODELS/ort"
  cp "$ort"/ort-wasm-simd-threaded*.wasm "$ort"/ort-wasm-simd-threaded*.mjs \
    "$PUBLIC_MODELS/ort/"
  echo "  copiado para public/models/ort/"
}

visao() {
  echo "== unsloth/Qwen3.8-27B-GGUF (projetor de visão)"
  baixar "$HF/unsloth/Qwen3.8-27B-GGUF/resolve/main/mmproj-F16.gguf" \
    "$MODELS_DIR/mmproj-Qwen3.8-27B-F16.gguf"
}

# fase 4b: Whisper grande rodando fora do navegador, em todos os núcleos
voz_servidor() {
  local src="${WHISPER_DIR:-$HOME/tools/whisper.cpp}" tag="v1.9.5"
  echo "== whisper.cpp $tag (compilado para esta CPU)"
  if [ ! -d "$src" ]; then
    git clone -q --depth 1 --branch "$tag" https://github.com/ggml-org/whisper.cpp.git "$src"
  fi
  if [ ! -x "$src/build/bin/whisper-server" ]; then
    # cmake e ninja num venv, sem mexer no sistema
    local tools="$HOME/tools/buildtools-venv"
    [ -x "$tools/bin/cmake" ] || { python3 -m venv "$tools" && "$tools/bin/pip" install -q cmake ninja; }
    PATH="$tools/bin:$PATH" cmake -S "$src" -B "$src/build" -G Ninja \
      -DCMAKE_BUILD_TYPE=Release -DGGML_NATIVE=ON -DWHISPER_BUILD_TESTS=OFF >/dev/null
    PATH="$tools/bin:$PATH" cmake --build "$src/build" -j "$(nproc)" \
      --target whisper-server whisper-cli >/dev/null
  fi
  echo "  ok: $src/build/bin/whisper-server"
  echo "== ggerganov/whisper.cpp (large-v3 q5_0)"
  baixar "$HF/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-q5_0.bin" \
    "$MODELS_DIR/whisper/ggml-large-v3-q5_0.bin"
  install -m 755 "$ROOT/ia-local/servicos/start-whisper.sh" "$src/start-whisper.sh"
  mkdir -p "$HOME/.config/systemd/user"
  cp "$ROOT/ia-local/servicos/whisper-local.service" "$HOME/.config/systemd/user/"
  echo "  para ligar: systemctl --user daemon-reload && systemctl --user enable --now whisper-local"
}

case "${1:-tudo}" in
  voz) voz ;;
  voz-servidor) voz_servidor ;;
  visao) visao ;;
  tudo) voz; voz_servidor; visao ;;
  *) echo "uso: $0 [voz|voz-servidor|visao|tudo]" >&2; exit 1 ;;
esac
