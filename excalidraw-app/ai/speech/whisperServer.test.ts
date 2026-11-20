import { afterEach, describe, expect, it, vi } from "vitest";

import {
  encodeWavBuffer,
  transcribeOnServer,
  WHISPER_VOCABULARY_PROMPT,
  WhisperServerUnavailable,
} from "./whisperServer";

const URL = "http://127.0.0.1:9932";
const audio = () => new Float32Array([0, 0.5, -0.5, 1, -1, 2]);

const mockFetch = (impl: (...args: any[]) => any) => {
  const fn = vi.fn(impl);
  vi.stubGlobal("fetch", fn);
  return fn;
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("encodeWav", () => {
  it("writes a 16 kHz mono 16-bit PCM WAV", async () => {
    const view = new DataView(encodeWavBuffer(audio()));
    const text = (offset: number) =>
      String.fromCharCode(
        ...new Uint8Array(view.buffer.slice(offset, offset + 4)),
      );
    expect(text(0)).toBe("RIFF");
    expect(text(8)).toBe("WAVE");
    expect(view.getUint16(22, true)).toBe(1);
    expect(view.getUint32(24, true)).toBe(16000);
    expect(view.getUint16(34, true)).toBe(16);
    expect(view.getUint32(40, true)).toBe(12);
    expect(view.byteLength).toBe(44 + 12);
    // clipped, not wrapped around
    expect(view.getInt16(44 + 3 * 2, true)).toBe(0x7fff);
    expect(view.getInt16(44 + 5 * 2, true)).toBe(0x7fff);
    expect(view.getInt16(44 + 4 * 2, true)).toBe(-0x8000);
  });
});

describe("transcribeOnServer", () => {
  it("sends WAV, language and the vocabulary prompt, and cleans the text", async () => {
    const fetch = mockFetch(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        text: " Apague tudo isso e faça um diagrama.\n",
      }),
    }));
    const result = await transcribeOnServer(audio(), { url: `${URL}/` });

    expect(result.text).toBe("Apague tudo isso e faça um diagrama.");
    const [endpoint, init] = fetch.mock.calls[0];
    expect(endpoint).toBe(`${URL}/inference`);
    const form = init.body as FormData;
    expect((form.get("file") as File).type).toBe("audio/wav");
    expect(form.get("language")).toBe("pt");
    expect(form.get("response_format")).toBe("json");
    expect(form.get("prompt")).toBe(WHISPER_VOCABULARY_PROMPT);
  });

  it("reports an unreachable server, so the browser model takes over", async () => {
    mockFetch(async () => {
      throw new TypeError("NetworkError when attempting to fetch resource.");
    });
    await expect(transcribeOnServer(audio(), { url: URL })).rejects.toThrow(
      WhisperServerUnavailable,
    );
    await expect(transcribeOnServer(audio(), { url: "" })).rejects.toThrow(
      WhisperServerUnavailable,
    );
  });

  it("passes the server's own error on", async () => {
    mockFetch(async () => ({
      ok: false,
      status: 400,
      json: async () => ({ error: "failed to read WAV file" }),
    }));
    const error = await transcribeOnServer(audio(), { url: URL }).catch(
      (error) => error,
    );
    expect(error).not.toBeInstanceOf(WhisperServerUnavailable);
    expect(error.message).toContain("failed to read WAV file");
  });

  it("treats the prompt heard back in silence as nothing heard", async () => {
    mockFetch(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        text: " Fluxograma, diagrama de sequência, wireframe, losango.",
      }),
    }));
    expect((await transcribeOnServer(audio(), { url: URL })).text).toBe("");
  });

  it("treats punctuation alone (silence) as nothing heard", async () => {
    mockFetch(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ text: " .\n" }),
    }));
    expect((await transcribeOnServer(audio(), { url: URL })).text).toBe("");
  });
});
