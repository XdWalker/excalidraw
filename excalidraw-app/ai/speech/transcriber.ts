/**
 * Local speech-to-text (fork ia-local, fase 4): records nothing by itself;
 * turns recorded audio into text with Whisper running in a Web Worker.
 */
import type { AsrRequest, AsrResponse, WhisperModel } from "./types";

export const WHISPER_SAMPLE_RATE = 16000;

export type TranscribeOptions = {
  model?: WhisperModel;
  /** Whisper's language name ("portuguese"), or "auto"-detect when omitted */
  language?: string;
  /** defaults to WebGPU when the browser has it, WebAssembly otherwise */
  device?: "wasm" | "webgpu";
  signal?: AbortSignal;
  onProgress?: (progress: { file?: string; progress?: number }) => void;
};

export type TranscribeResult = {
  text: string;
  seconds: number;
  loadSeconds: number;
};

export const DEFAULT_WHISPER_MODEL: WhisperModel =
  (import.meta.env.VITE_APP_LOCAL_ASR_MODEL as WhisperModel) || "whisper-small";

/**
 * Mixes any recording down to mono and resamples it to 16 kHz, what Whisper
 * expects.
 */
export const toWhisperAudio = async (
  input: Blob | ArrayBuffer,
): Promise<Float32Array> => {
  const buffer = input instanceof Blob ? await input.arrayBuffer() : input;
  // decodeAudioData resamples to the context's rate
  const context = new OfflineAudioContext(
    1,
    WHISPER_SAMPLE_RATE,
    WHISPER_SAMPLE_RATE,
  );
  const decoded = await context.decodeAudioData(buffer.slice(0));
  if (
    decoded.sampleRate === WHISPER_SAMPLE_RATE &&
    decoded.numberOfChannels === 1
  ) {
    return decoded.getChannelData(0);
  }
  const length = Math.ceil(decoded.duration * WHISPER_SAMPLE_RATE);
  const offline = new OfflineAudioContext(1, length, WHISPER_SAMPLE_RATE);
  const source = offline.createBufferSource();
  source.buffer = decoded;
  source.connect(offline.destination);
  source.start();
  const rendered = await offline.startRendering();
  return rendered.getChannelData(0);
};

let worker: Worker | null = null;
let nextId = 1;
const pending = new Map<
  number,
  {
    resolve: (result: TranscribeResult) => void;
    reject: (error: Error) => void;
    onProgress?: TranscribeOptions["onProgress"];
  }
>();

const getWorker = () => {
  if (!worker) {
    worker = new Worker(new URL("./asr.worker.ts", import.meta.url), {
      type: "module",
    });
    worker.onmessage = (event: MessageEvent<AsrResponse>) => {
      const message = event.data;
      const request = pending.get(message.id);
      if (!request) {
        return;
      }
      if (message.type === "progress") {
        request.onProgress?.(message);
        return;
      }
      pending.delete(message.id);
      if (message.type === "result") {
        request.resolve({
          text: message.text,
          seconds: message.seconds,
          loadSeconds: message.loadSeconds,
        });
      } else {
        request.reject(new Error(message.message));
      }
    };
    worker.onerror = (event) => {
      const error = new Error(event.message || "speech worker failed");
      pending.forEach((request) => request.reject(error));
      pending.clear();
      worker?.terminate();
      worker = null;
    };
  }
  return worker;
};

const preferredDevice = (): "wasm" | "webgpu" =>
  typeof navigator !== "undefined" && "gpu" in navigator ? "webgpu" : "wasm";

export const transcribe = (
  audio: Float32Array,
  {
    model = DEFAULT_WHISPER_MODEL,
    language = "portuguese",
    device,
    signal,
    onProgress,
  }: TranscribeOptions = {},
): Promise<TranscribeResult> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    const id = nextId++;
    pending.set(id, { resolve, reject, onProgress });
    signal?.addEventListener("abort", () => {
      if (pending.delete(id)) {
        reject(new DOMException("Aborted", "AbortError"));
      }
    });
    const request: AsrRequest = {
      id,
      audio,
      model,
      device:
        device ||
        (import.meta.env.VITE_APP_LOCAL_ASR_DEVICE as "wasm" | "webgpu") ||
        preferredDevice(),
      language,
    };
    getWorker().postMessage(request, [audio.buffer]);
  });
