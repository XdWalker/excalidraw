import { useCallback, useEffect, useId, useState } from "react";

import { t } from "@excalidraw/excalidraw/i18n";

import {
  fetchLocalLLMModels,
  getDefaultLocalLLMConfig,
  getHostLabel,
  loadLocalLLMConfig,
  normalizeBaseURL,
  saveLocalLLMConfig,
} from "../ai/localLLM";

import "./LocalAIStatus.scss";

import type { LocalLLMConfig } from "../ai/localLLM";

type Status = "checking" | "online" | "offline";

const CHECK_TIMEOUT_MS = 4000;

const listModels = async (baseURL: string, signal?: AbortSignal) => {
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), CHECK_TIMEOUT_MS);
  signal?.addEventListener("abort", () => timeout.abort());
  try {
    return await fetchLocalLLMModels(baseURL, timeout.signal);
  } finally {
    clearTimeout(timer);
  }
};

/**
 * Selo "IA local · modelo @ host" no cabeçalho do diálogo "Texto para
 * diagrama", com o estado da conexão e um painel para trocar o servidor.
 */
export const LocalAIStatus = () => {
  const [config, setConfig] = useState<LocalLLMConfig>(loadLocalLLMConfig);
  const [status, setStatus] = useState<Status>("checking");
  const [models, setModels] = useState<string[]>([]);
  const [isOpen, setIsOpen] = useState(false);
  const [draft, setDraft] = useState<LocalLLMConfig>(config);
  const [testMessage, setTestMessage] = useState<{
    ok: boolean;
    text: string;
  } | null>(null);
  const datalistId = useId();

  useEffect(() => {
    const controller = new AbortController();
    setStatus("checking");
    listModels(config.baseURL, controller.signal).then(
      (list) => {
        setModels(list);
        setStatus("online");
      },
      () => {
        if (!controller.signal.aborted) {
          setModels([]);
          setStatus("offline");
        }
      },
    );
    return () => controller.abort();
  }, [config]);

  const testDraft = useCallback(async () => {
    setTestMessage(null);
    try {
      const list = await listModels(draft.baseURL);
      setModels(list);
      setTestMessage({
        ok: true,
        text: t("localAI.modelsFound", { count: list.length }),
      });
    } catch {
      setTestMessage({
        ok: false,
        text: t("localAI.errors.unreachable", {
          url: normalizeBaseURL(draft.baseURL),
        }),
      });
    }
  }, [draft.baseURL]);

  const save = () => {
    const next = { ...draft, baseURL: normalizeBaseURL(draft.baseURL) };
    saveLocalLLMConfig(next);
    setConfig(next);
    setIsOpen(false);
    setTestMessage(null);
  };

  const modelLabel = config.model || models[0] || "?";
  const statusLabel = t(
    status === "online"
      ? "localAI.statusOnline"
      : status === "offline"
      ? "localAI.statusOffline"
      : "localAI.statusChecking",
  );

  return (
    <div className="local-ai-status">
      <button
        type="button"
        className="local-ai-status__badge"
        data-status={status}
        title={`${t("localAI.badge")}: ${statusLabel}. ${t(
          "localAI.privacyNote",
        )}`}
        aria-expanded={isOpen}
        onClick={() => {
          setDraft(config);
          setTestMessage(null);
          setIsOpen((open) => !open);
        }}
      >
        <span className="local-ai-status__dot" aria-hidden="true" />
        <span className="local-ai-status__text">
          <strong>{t("localAI.badge")}</strong> · {modelLabel} @{" "}
          {getHostLabel(config.baseURL)}
        </span>
      </button>

      {isOpen && (
        <div
          className="local-ai-status__popover"
          role="dialog"
          aria-label={t("localAI.settingsTitle")}
        >
          <div className="local-ai-status__title">
            {t("localAI.settingsTitle")}
          </div>

          <label className="local-ai-status__field">
            <span>{t("localAI.serverUrl")}</span>
            <input
              type="url"
              value={draft.baseURL}
              spellCheck={false}
              onChange={(event) =>
                setDraft((prev) => ({ ...prev, baseURL: event.target.value }))
              }
            />
          </label>

          <label className="local-ai-status__field">
            <span>{t("localAI.model")}</span>
            <input
              type="text"
              value={draft.model}
              list={datalistId}
              placeholder={t("localAI.modelAuto")}
              spellCheck={false}
              onChange={(event) =>
                setDraft((prev) => ({ ...prev, model: event.target.value }))
              }
            />
            <datalist id={datalistId}>
              {models.map((model) => (
                <option key={model} value={model} />
              ))}
            </datalist>
          </label>

          {testMessage && (
            <div
              className="local-ai-status__test"
              data-ok={testMessage.ok ? "true" : "false"}
            >
              {testMessage.text}
            </div>
          )}

          <p className="local-ai-status__note">{t("localAI.privacyNote")}</p>

          <div className="local-ai-status__actions">
            <button
              type="button"
              className="local-ai-status__link"
              onClick={() => {
                setDraft(getDefaultLocalLLMConfig());
                setTestMessage(null);
              }}
            >
              {t("localAI.reset")}
            </button>
            <button type="button" onClick={testDraft}>
              {t("localAI.test")}
            </button>
            <button
              type="button"
              className="local-ai-status__primary"
              onClick={save}
            >
              {t("localAI.save")}
            </button>
          </div>
        </div>
      )}
    </div>
  );
};
