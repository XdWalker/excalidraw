import { vi } from "vitest";

import { appendSpokenText } from "../components/TTDDialog/utils/voice";
import { Excalidraw, TTDDialog } from "../index";

import { act, fireEvent, render, waitFor } from "./test-utils";

import type { TTTDDialog } from "../components/TTDDialog/types";

/** jsdom has no microphone: a MediaRecorder that "records" a fixed blob */
class FakeMediaRecorder {
  static isTypeSupported = () => true;
  state: "inactive" | "recording" = "inactive";
  mimeType = "audio/webm";
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  constructor(public stream: MediaStream) {}
  start() {
    this.state = "recording";
  }
  stop() {
    this.state = "inactive";
    this.ondataavailable?.({
      data: new Blob(["fake audio"], { type: "audio/webm" }),
    });
    this.onstop?.();
  }
}

const stopTrack = vi.fn();
const fakeStream = {
  getTracks: () => [{ stop: stopTrack }],
} as unknown as MediaStream;

const renderDialog = async (
  onTranscribeAudio: TTTDDialog.onTranscribeAudio,
  tab: "text-to-diagram" | "wireframe" = "text-to-diagram",
) =>
  render(
    <Excalidraw
      initialData={{ appState: { openDialog: { name: "ttd", tab } } }}
    >
      <TTDDialog
        onTextSubmit={async () => ({ generatedResponse: "", error: null })}
        onWireframeSubmit={async () => ({ error: new Error("n/a") })}
        onTranscribeAudio={onTranscribeAudio}
        persistenceAdapter={{
          loadChats: async () => [],
          saveChats: async () => {},
        }}
      />
    </Excalidraw>,
  );

const micButton = () =>
  document.querySelector<HTMLButtonElement>(
    '.ttd-dialog [data-testid="voice-input-button"]',
  )!;

describe("appendSpokenText", () => {
  it("capitalizes a new request and appends to an existing one", () => {
    expect(appendSpokenText("", "fluxograma de login")).toBe(
      "Fluxograma de login",
    );
    expect(appendSpokenText("Fluxograma de login ", "com 2FA")).toBe(
      "Fluxograma de login com 2FA",
    );
    expect(appendSpokenText("abc", "   ")).toBe("abc");
  });
});

describe("voice input", () => {
  beforeAll(() => {
    // jsdom doesn't implement it; the chat scrolls to its last message
    Element.prototype.scrollIntoView ??= vi.fn();
  });

  beforeEach(() => {
    (window as any).MediaRecorder = FakeMediaRecorder;
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia: vi.fn().mockResolvedValue(fakeStream) },
    });
    stopTrack.mockClear();
  });

  it("records, transcribes and puts the text in the request box", async () => {
    const onTranscribeAudio = vi
      .fn()
      .mockResolvedValue({ text: "fluxograma de compra", error: null });
    await renderDialog(onTranscribeAudio);

    expect(micButton()).not.toBeNull();
    await act(async () => {
      fireEvent.click(micButton());
    });
    expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledWith({
      audio: true,
    });
    expect(micButton().title).toBe("Stop recording");

    await act(async () => {
      fireEvent.click(micButton());
    });

    await waitFor(() =>
      expect(
        document.querySelector<HTMLTextAreaElement>(".chat-interface__input")!
          .value,
      ).toBe("Fluxograma de compra"),
    );
    const { audio } = onTranscribeAudio.mock.calls[0][0];
    expect(audio).toBeInstanceOf(Blob);
    // the microphone is released after recording
    expect(stopTrack).toHaveBeenCalled();
  });

  it("works in the wireframe tab too", async () => {
    await renderDialog(
      async () => ({ text: "tela de login", error: null }),
      "wireframe",
    );
    await act(async () => {
      fireEvent.click(micButton());
    });
    await act(async () => {
      fireEvent.click(micButton());
    });
    await waitFor(() =>
      expect(
        document.querySelector<HTMLTextAreaElement>(
          ".ttd-dialog-wireframe-input",
        )!.value,
      ).toBe("Tela de login"),
    );
  });

  it("explains a denied microphone permission", async () => {
    (navigator.mediaDevices.getUserMedia as any).mockRejectedValue(
      Object.assign(new Error("denied"), { name: "NotAllowedError" }),
    );
    const onTranscribeAudio = vi.fn();
    await renderDialog(onTranscribeAudio);

    await act(async () => {
      fireEvent.click(micButton());
    });

    await waitFor(() =>
      expect(
        document.querySelector('[data-testid="voice-error"]')?.textContent,
      ).toMatch(/denied/i),
    );
    expect(onTranscribeAudio).not.toHaveBeenCalled();
  });

  it("shows the host's transcription error", async () => {
    await renderDialog(async () => ({ error: new Error("modelo ausente") }));
    await act(async () => {
      fireEvent.click(micButton());
    });
    await act(async () => {
      fireEvent.click(micButton());
    });
    await waitFor(() =>
      expect(
        document.querySelector('[data-testid="voice-error"]')?.textContent,
      ).toContain("modelo ausente"),
    );
  });

  it("isn't shown when the host can't transcribe", async () => {
    await render(
      <Excalidraw
        initialData={{
          appState: { openDialog: { name: "ttd", tab: "text-to-diagram" } },
        }}
      >
        <TTDDialog
          onTextSubmit={async () => ({ generatedResponse: "", error: null })}
          persistenceAdapter={{
            loadChats: async () => [],
            saveChats: async () => {},
          }}
        />
      </Excalidraw>,
    );
    expect(micButton()).toBeNull();
  });
});
