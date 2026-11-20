/**
 * Web Worker: speech-to-text with Whisper in the browser (fork ia-local,
 * fase 4). transformers.js + ONNX Runtime (WebAssembly, or WebGPU when the
 * browser has it). Models and the runtime are served by the app itself
 * (public/models/, see ia-local/baixar-modelos.sh): nothing is fetched from
 * the internet and no audio leaves the machine.
 */
import { env, pipeline } from "@huggingface/transformers";

import type { AutomaticSpeechRecognitionPipeline } from "@huggingface/transformers";

import type { AsrRequest, AsrResponse } from "./types";

env.allowRemoteModels = false;
env.allowLocalModels = true;
// must be a path, not a full URL: transformers.js 4.3 only checks which
// optional files exist (e.g. the tokenizer) for paths
env.localModelPath = "/models/";
// the files are already local (and in the HTTP cache): keeping a second copy
// of hundreds of MB in Cache Storage would only waste disk
env.useBrowserCache = false;
if (env.backends.onnx.wasm) {
  env.backends.onnx.wasm.wasmPaths = new URL(
    "/models/ort/",
    self.location.origin,
  ).href;
  // more than one thread needs a cross-origin isolated page
  env.backends.onnx.wasm.numThreads = self.crossOriginIsolated
    ? Math.min(4, navigator.hardwareConcurrency || 1)
    : 1;
}

let loaded: {
  key: string;
  pipeline: Promise<AutomaticSpeechRecognitionPipeline>;
} | null = null;

const post = (message: AsrResponse) => self.postMessage(message);

const getPipeline = (model: string, device: "wasm" | "webgpu", id: number) => {
  const key = `${model}|${device}`;
  if (loaded?.key !== key) {
    loaded = {
      key,
      pipeline: pipeline(
        "automatic-speech-recognition",
        `onnx-community/${model}`,
        {
          device,
          // the q8 files from ia-local/baixar-modelos.sh
          dtype: { encoder_model: "q8", decoder_model_merged: "q8" },
          progress_callback: (progress: any) => {
            if (progress?.status === "progress") {
              post({
                id,
                type: "progress",
                file: progress.file,
                progress: progress.progress,
              });
            }
          },
        },
      ) as Promise<AutomaticSpeechRecognitionPipeline>,
    };
    loaded.pipeline.catch(() => {
      loaded = null;
    });
  }
  return loaded.pipeline;
};

/**
 * Some browsers expose `navigator.gpu` without a usable adapter (e.g. a
 * Chromium without the WebGPU flag): only use WebGPU when it really works.
 */
let webgpuUsable: Promise<boolean> | null = null;
const resolveDevice = async (
  requested: "wasm" | "webgpu",
): Promise<"wasm" | "webgpu"> => {
  if (requested !== "webgpu") {
    return "wasm";
  }
  webgpuUsable ??= (async () => {
    try {
      const gpu = (navigator as any).gpu;
      return !!(gpu && (await gpu.requestAdapter()));
    } catch {
      return false;
    }
  })();
  return (await webgpuUsable) ? "webgpu" : "wasm";
};

self.onmessage = async (event: MessageEvent<AsrRequest>) => {
  const { id, audio, model, language } = event.data;
  try {
    const startLoad = performance.now();
    const device = await resolveDevice(event.data.device);
    const asr = await getPipeline(model, device, id).catch((error) => {
      if (device === "webgpu") {
        // WebGPU found but failed to run the model: WebAssembly always works
        webgpuUsable = Promise.resolve(false);
        return getPipeline(model, "wasm", id);
      }
      throw error;
    });
    const loadSeconds = (performance.now() - startLoad) / 1000;

    const start = performance.now();
    const output = await asr(audio, {
      language,
      task: "transcribe",
      // long recordings are transcribed in 30 s windows
      chunk_length_s: 30,
      stride_length_s: 5,
    });
    const text = (Array.isArray(output) ? output[0] : output).text.trim();
    post({
      id,
      type: "result",
      text,
      seconds: (performance.now() - start) / 1000,
      loadSeconds,
    });
  } catch (error: any) {
    post({ id, type: "error", message: String(error?.message ?? error) });
  }
};
