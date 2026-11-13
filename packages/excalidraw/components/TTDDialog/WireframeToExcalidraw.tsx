import { useCallback, useEffect, useRef, useState } from "react";

import { DEFAULT_EXPORT_PADDING, KEYS } from "@excalidraw/common";
import { convertToExcalidrawElements } from "@excalidraw/element";
import { exportScene } from "@excalidraw/utils";

import type { NonDeletedExcalidrawElement } from "@excalidraw/element/types";

import { useUIAppState } from "../../context/ui-appState";
import { t } from "../../i18n";
import { layoutWireframe } from "../../wireframe/layout";
import { useApp } from "../App";
import { ArrowRightIcon, alertTriangleIcon } from "../icons";
import Spinner from "../Spinner";

import { insertToEditor } from "./common";
import { TTDDialogPanel } from "./TTDDialogPanel";
import { TTDDialogPanels } from "./TTDDialogPanels";
import { TTDDialogSubmitShortcut } from "./TTDDialogSubmitShortcut";

import type { BinaryFiles } from "../../types";
import type { Wireframe } from "../../wireframe/wireframe";
import type { TTTDDialog } from "./types";

/**
 * "Wireframe" tab (fork ia-local, fase 3): a request in plain words becomes
 * an editable UI wireframe. The host's `onWireframeSubmit` returns only the
 * structure (e.g. from a local LLM); the layout is computed here.
 */
export const WireframeToExcalidraw = ({
  onWireframeSubmit,
}: {
  onWireframeSubmit: TTTDDialog.onWireframeSubmit;
}) => {
  const app = useApp();
  const { theme } = useUIAppState();

  const [prompt, setPrompt] = useState("");
  const [wireframe, setWireframe] = useState<Wireframe | null>(null);
  const [isGenerating, setIsGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [seconds, setSeconds] = useState<number | null>(null);

  const canvasRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const data = useRef<{
    elements: readonly NonDeletedExcalidrawElement[];
    files: BinaryFiles | null;
  }>({ elements: [], files: null });

  useEffect(() => () => abortRef.current?.abort(), []);

  // draw the preview whenever there's a new wireframe (or the theme changes)
  useEffect(() => {
    const canvasNode = canvasRef.current;
    const parent = canvasNode?.parentElement;
    if (!canvasNode || !parent) {
      return;
    }
    if (!wireframe) {
      data.current = { elements: [], files: null };
      canvasNode.replaceChildren();
      parent.style.background = "";
      return;
    }

    let cancelled = false;
    const elements = convertToExcalidrawElements(layoutWireframe(wireframe), {
      regenerateIds: true,
      renderEnvironment: app.renderEnvironment,
    });
    data.current = { elements, files: null };

    exportScene({
      type: "canvas",
      data: { elements, files: null },
      config: {
        padding: DEFAULT_EXPORT_PADDING,
        maxWidthOrHeight:
          Math.max(parent.offsetWidth, parent.offsetHeight) *
          (app.ownerWindow.devicePixelRatio ?? 1),
        theme,
      },
    }).then(
      (canvas) => {
        if (!cancelled) {
          parent.style.background = "var(--default-bg-color)";
          canvasNode.replaceChildren(canvas);
        }
      },
      (err) => {
        if (!cancelled) {
          setError(err?.message ?? String(err));
        }
      },
    );

    return () => {
      cancelled = true;
    };
  }, [wireframe, theme, app]);

  const generate = useCallback(async () => {
    const request = prompt.trim();
    if (request.length < 3 || isGenerating) {
      return;
    }
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setIsGenerating(true);
    setError(null);
    const start = performance.now();
    try {
      const result = await onWireframeSubmit({
        prompt: request,
        previous: wireframe,
        signal: controller.signal,
      });
      if (controller.signal.aborted) {
        return;
      }
      if (result.error) {
        setError(result.error.message);
        return;
      }
      setWireframe(result.wireframe);
      setSeconds((performance.now() - start) / 1000);
      setPrompt("");
    } catch (err: any) {
      if (!controller.signal.aborted) {
        setError(err?.message ?? String(err));
      }
    } finally {
      if (abortRef.current === controller) {
        abortRef.current = null;
        setIsGenerating(false);
      }
    }
  }, [prompt, wireframe, isGenerating, onWireframeSubmit]);

  const startOver = () => {
    abortRef.current?.abort();
    setWireframe(null);
    setSeconds(null);
    setError(null);
    setPrompt("");
  };

  const insert = () => {
    if (wireframe) {
      insertToEditor({ app, data });
    }
  };

  return (
    <>
      <div className="ttd-dialog-desc">{t("wireframe.description")}</div>
      <TTDDialogPanels>
        <TTDDialogPanel
          label={wireframe ? wireframe.title : undefined}
          onTextSubmitInProgess={isGenerating}
          panelActionJustifyContent="space-between"
          panelActions={[
            ...(wireframe
              ? [
                  {
                    label: t("wireframe.new"),
                    action: startOver,
                    variant: "link" as const,
                  },
                ]
              : []),
            {
              label: wireframe
                ? t("wireframe.refine")
                : t("wireframe.generate"),
              action: generate,
              icon: ArrowRightIcon,
              variant: "button",
              disabled: prompt.trim().length < 3,
            },
          ]}
          renderSubmitShortcut={() => <TTDDialogSubmitShortcut />}
        >
          <textarea
            className="ttd-dialog-wireframe-input"
            value={prompt}
            autoFocus
            spellCheck
            placeholder={
              wireframe
                ? t("wireframe.refinePlaceholder")
                : t("wireframe.placeholder")
            }
            onChange={(event) => setPrompt(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === KEYS.ENTER && event[KEYS.CTRL_OR_CMD]) {
                event.preventDefault();
                generate();
              }
            }}
          />
        </TTDDialogPanel>
        <TTDDialogPanel
          label={
            seconds !== null && wireframe
              ? t("wireframe.generatedIn", {
                  seconds: seconds.toFixed(1).replace(".", ","),
                })
              : undefined
          }
          panelActions={[
            {
              label: t("mermaid.button"),
              action: insert,
              icon: ArrowRightIcon,
              variant: "button",
              disabled: !wireframe || isGenerating,
            },
          ]}
        >
          <div
            className={`ttd-dialog-output-wrapper ${
              error ? "ttd-dialog-output-wrapper--error" : ""
            }`}
          >
            {error && (
              <div
                className="ttd-dialog-output-error"
                data-testid="wireframe-error"
              >
                <div className="ttd-dialog-output-error-content">
                  <div className="ttd-dialog-output-error-icon">
                    {alertTriangleIcon}
                  </div>
                  <div className="ttd-dialog-output-error-message">{error}</div>
                </div>
              </div>
            )}
            {isGenerating && <Spinner size="2rem" />}
            {!wireframe && !isGenerating && !error && (
              <div className="ttd-dialog-wireframe-empty">
                {t("wireframe.empty")}
              </div>
            )}
            <div
              className="ttd-dialog-output-canvas-container"
              style={{ display: wireframe && !error ? undefined : "none" }}
            >
              <div
                ref={canvasRef}
                className="ttd-dialog-output-canvas-content"
              />
            </div>
          </div>
        </TTDDialogPanel>
      </TTDDialogPanels>
    </>
  );
};
