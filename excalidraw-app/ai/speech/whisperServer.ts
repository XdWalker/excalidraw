/**
 * Voice through a local whisper.cpp server (fork ia-local, fase 4b): the
 * browser runs Whisper on one CPU core, so only small models are usable
 * there. whisper-server runs natively on every core, which makes the large-v3
 * model affordable. Measured on the base PC (Ryzen 7 7700X, CPU only, the GPU
 * is busy with the LLM): ~6.7 s per request, 3.6% word errors, against 13.4%
 * for whisper-small. See ia-local/README.md.
 */
import { WHISPER_SAMPLE_RATE } from "./transcriber";

/** empty: no server, the browser model is used */
export const LOCAL_ASR_URL: string = (
  import.meta.env.VITE_APP_LOCAL_ASR_URL || ""
).replace(/\/+$/, "");

/**
 * Words the requests use. Whisper takes them as the "previous text", which
 * steers it towards them ("Apague tudo isso" instead of "A parte de tudo
 * isso"): measured, word errors went from 7.2% to 3.6%.
 */
export const WHISPER_VOCABULARY_PROMPT =
  "Pedido para um editor de diagramas: fluxograma, diagrama de sequência, " +
  "wireframe, losango, retângulo, seta, apague, adicione, troque, ligue, " +
  "e-mail, login, API, banco de dados.";

/** the server can't decode webm/ogg without ffmpeg: send plain 16-bit WAV */
export const encodeWavBuffer = (
  samples: Float32Array,
  sampleRate = WHISPER_SAMPLE_RATE,
): ArrayBuffer => {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const ascii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) {
      view.setUint8(offset + i, text.charCodeAt(i));
    }
  };
  ascii(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true); // fmt chunk size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  ascii(36, "data");
  view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const sample = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(
      44 + i * 2,
      sample < 0 ? sample * 0x8000 : sample * 0x7fff,
      true,
    );
  }
  return buffer;
};

export const encodeWav = (samples: Float32Array): Blob =>
  new Blob([encodeWavBuffer(samples)], { type: "audio/wav" });

/** the server isn't running (or isn't reachable): use the browser model */
export class WhisperServerUnavailable extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "WhisperServerUnavailable";
  }
}

/**
 * Whisper sometimes "hears" its prompt in silence: an answer made only of
 * prompt words is treated as nothing heard.
 */
const isPromptEcho = (text: string) => {
  const words = (value: string) =>
    value
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s-]/gu, " ")
      .split(/\s+/)
      .filter(Boolean);
  const promptWords = new Set(words(WHISPER_VOCABULARY_PROMPT));
  const heard = words(text);
  return heard.length > 3 && heard.every((word) => promptWords.has(word));
};

export const transcribeOnServer = async (
  audio: Float32Array,
  {
    url = LOCAL_ASR_URL,
    language = "pt",
    prompt = WHISPER_VOCABULARY_PROMPT,
    signal,
  }: {
    url?: string;
    /** ISO code ("pt"), as whisper.cpp expects */
    language?: string;
    prompt?: string;
    signal?: AbortSignal;
  } = {},
): Promise<{ text: string; seconds: number }> => {
  if (!url) {
    throw new WhisperServerUnavailable("no server configured");
  }
  const form = new FormData();
  form.append("file", encodeWav(audio), "audio.wav");
  form.append("response_format", "json");
  form.append("language", language);
  form.append("temperature", "0");
  if (prompt) {
    form.append("prompt", prompt);
  }

  const startedAt = performance.now();
  let response: Response;
  try {
    response = await fetch(`${url.replace(/\/+$/, "")}/inference`, {
      method: "POST",
      body: form,
      signal,
    });
  } catch (error: any) {
    if (signal?.aborted) {
      throw error;
    }
    throw new WhisperServerUnavailable(String(error?.message ?? error));
  }
  const body = await response.json().catch(() => null);
  if (!response.ok || !body || typeof body.text !== "string") {
    throw new Error(body?.error || `whisper-server: HTTP ${response.status}`);
  }
  const text = body.text.replace(/\s+/g, " ").trim();
  return {
    // silence comes back as "." or nothing but the prompt
    text: !/[\p{L}\p{N}]/u.test(text) || isPromptEcho(text) ? "" : text,
    seconds: (performance.now() - startedAt) / 1000,
  };
};
