export type WhisperModel = "whisper-base" | "whisper-small";

export type AsrRequest = {
  id: number;
  /** mono PCM, 16 kHz */
  audio: Float32Array;
  model: WhisperModel;
  device: "wasm" | "webgpu";
  language: string;
};

export type AsrResponse =
  | { id: number; type: "progress"; file?: string; progress?: number }
  | {
      id: number;
      type: "result";
      text: string;
      /** transcription time, without loading the model */
      seconds: number;
      /** model loading time (0 when it was already loaded) */
      loadSeconds: number;
    }
  | { id: number; type: "error"; message: string };
