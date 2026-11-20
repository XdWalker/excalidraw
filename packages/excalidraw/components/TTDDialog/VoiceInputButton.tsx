import clsx from "clsx";
import { useEffect, useRef, useState } from "react";

import { t } from "../../i18n";
import { microphoneIcon, stop as StopIcon } from "../icons";
import { InlineIcon } from "../InlineIcon";
import Spinner from "../Spinner";

import type { TTTDDialog } from "./types";

/** long requests are fine, but don't record forever by accident */
export const VOICE_MAX_SECONDS = 120;

type State =
  | { name: "idle" }
  | { name: "recording"; seconds: number }
  | { name: "transcribing"; progress?: number }
  | { name: "error"; message: string };

const formatTime = (seconds: number) =>
  `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;

const pickMimeType = () => {
  if (typeof MediaRecorder === "undefined") {
    return undefined;
  }
  return ["audio/webm;codecs=opus", "audio/ogg;codecs=opus", "audio/webm"].find(
    (type) => MediaRecorder.isTypeSupported?.(type),
  );
};

/**
 * Voice input (fork ia-local, fase 4): records from the microphone and hands
 * the audio to the host's `onTranscribeAudio` (e.g. Whisper running locally
 * in the browser). The text is appended to the request, for the user to
 * review before sending: nothing is sent automatically.
 */
export const VoiceInputButton = ({
  onTranscribeAudio,
  onText,
  disabled,
  className,
}: {
  onTranscribeAudio: TTTDDialog.onTranscribeAudio;
  onText: (text: string) => void;
  disabled?: boolean;
  className?: string;
}) => {
  const [state, setState] = useState<State>({ name: "idle" });
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<number | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const releaseMicrophone = () => {
    if (timerRef.current !== null) {
      window.clearInterval(timerRef.current);
      timerRef.current = null;
    }
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
  };

  useEffect(
    () => () => {
      abortRef.current?.abort();
      if (recorderRef.current?.state === "recording") {
        recorderRef.current.onstop = null;
        recorderRef.current.stop();
      }
      releaseMicrophone();
    },
    [],
  );

  const transcribe = async (audio: Blob) => {
    const controller = new AbortController();
    abortRef.current = controller;
    setState({ name: "transcribing" });
    try {
      const result = await onTranscribeAudio({
        audio,
        signal: controller.signal,
        onProgress: ({ progress }) =>
          setState({ name: "transcribing", progress }),
      });
      if (controller.signal.aborted) {
        return;
      }
      if (result.error) {
        setState({ name: "error", message: result.error.message });
        return;
      }
      const text = result.text.trim();
      if (!text) {
        setState({ name: "error", message: t("voice.nothingHeard") });
        return;
      }
      onText(text);
      setState({ name: "idle" });
    } catch (error: any) {
      if (!controller.signal.aborted) {
        setState({
          name: "error",
          message: error?.message ?? String(error),
        });
      }
    }
  };

  const start = async () => {
    if (!navigator.mediaDevices?.getUserMedia) {
      setState({ name: "error", message: t("voice.unsupported") });
      return;
    }
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (error: any) {
      setState({
        name: "error",
        message:
          error?.name === "NotAllowedError"
            ? t("voice.permissionDenied")
            : t("voice.noMicrophone"),
      });
      return;
    }
    streamRef.current = stream;
    chunksRef.current = [];
    const mimeType = pickMimeType();
    const recorder = new MediaRecorder(
      stream,
      mimeType ? { mimeType } : undefined,
    );
    recorderRef.current = recorder;
    recorder.ondataavailable = (event) => {
      if (event.data.size) {
        chunksRef.current.push(event.data);
      }
    };
    recorder.onstop = () => {
      releaseMicrophone();
      const audio = new Blob(chunksRef.current, {
        type: recorder.mimeType || mimeType || "audio/webm",
      });
      chunksRef.current = [];
      if (audio.size) {
        transcribe(audio);
      } else {
        setState({ name: "error", message: t("voice.nothingHeard") });
      }
    };
    recorder.start();
    const startedAt = Date.now();
    setState({ name: "recording", seconds: 0 });
    timerRef.current = window.setInterval(() => {
      const seconds = Math.floor((Date.now() - startedAt) / 1000);
      if (seconds >= VOICE_MAX_SECONDS) {
        stop();
        return;
      }
      setState({ name: "recording", seconds });
    }, 250);
  };

  const stop = () => {
    if (recorderRef.current?.state === "recording") {
      recorderRef.current.stop();
    }
  };

  const onClick = () => {
    if (state.name === "recording") {
      stop();
    } else if (state.name === "transcribing") {
      abortRef.current?.abort();
      setState({ name: "idle" });
    } else {
      start();
    }
  };

  const title =
    state.name === "recording"
      ? t("voice.stop")
      : state.name === "transcribing"
      ? t("voice.cancel")
      : t("voice.start");

  return (
    <div className={clsx("ttd-voice-input", className)}>
      {state.name === "recording" && (
        <span className="ttd-voice-input__status" aria-live="polite">
          <span className="ttd-voice-input__dot" />
          {formatTime(state.seconds)}
        </span>
      )}
      {state.name === "transcribing" && (
        <span className="ttd-voice-input__status" aria-live="polite">
          {t("voice.transcribing")}
          {typeof state.progress === "number" && state.progress < 100
            ? ` ${Math.round(state.progress)}%`
            : ""}
        </span>
      )}
      {state.name === "error" && (
        <span
          className="ttd-voice-input__status ttd-voice-input__status--error"
          role="alert"
          data-testid="voice-error"
        >
          {state.message}
        </span>
      )}
      <button
        type="button"
        className={clsx("ttd-voice-input__button", {
          "ttd-voice-input__button--recording": state.name === "recording",
        })}
        onClick={onClick}
        disabled={disabled && state.name === "idle"}
        title={title}
        aria-label={title}
        data-testid="voice-input-button"
      >
        {state.name === "transcribing" ? (
          <Spinner size="1em" />
        ) : (
          <InlineIcon
            size="1.25em"
            icon={state.name === "recording" ? StopIcon : microphoneIcon}
          />
        )}
      </button>
    </div>
  );
};
