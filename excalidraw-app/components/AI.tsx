import {
  DiagramToCodePlugin,
  exportScene,
  getNonDeletedElements,
  getTextFromElements,
  parseSSEStream,
  TTDDialog,
  THEME,
  useOnExcalidrawStateChange,
} from "@excalidraw/excalidraw";
import { getDataURL } from "@excalidraw/excalidraw/data/blob";
import { safelyParseJSON } from "@excalidraw/common";

import type { StreamChunk } from "@excalidraw/excalidraw";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";

import {
  loadLocalLLMConfig,
  localLLMStreamFetch,
  localLLMWireframeFetch,
} from "../ai/localLLM";
import { cacheMermaidChunks } from "../data/cacheMermaidChunks";
import { TTDIndexedDBAdapter } from "../data/TTDStorage";

import { LocalAIStatus } from "./LocalAIStatus";

export const AIComponents = ({
  excalidrawAPI,
}: {
  excalidrawAPI: ExcalidrawImperativeAPI;
}) => {
  useOnExcalidrawStateChange(
    (appState) => appState.openDialog?.name === "ttd",
    (isTTDDialogOpen) => {
      if (isTTDDialogOpen) {
        cacheMermaidChunks();
      }
    },
  );

  return (
    <>
      <DiagramToCodePlugin
        generate={async ({ frame, children, onPartial }) => {
          const appState = excalidrawAPI.getAppState();

          // SAFETY: This should never happen, but log it just in case
          if (children.some((el) => el.isDeleted)) {
            console.error(
              "[NONDELETED][INVARIANT] Generated children elements should not be `isDeleted: true`",
            );
          }

          const blob = await exportScene({
            type: "jpeg",
            data: {
              elements: getNonDeletedElements(children),
              appState,
              files: excalidrawAPI.getFiles(),
            },
            config: {
              exportingFrame: frame,
              theme: appState.exportWithDarkMode ? THEME.DARK : THEME.LIGHT,
            },
          });

          const dataURL = await getDataURL(blob);

          const textFromFrameChildren = getTextFromElements(children);

          const response = await fetch(
            `${
              import.meta.env.VITE_APP_AI_BACKEND
            }/v1/ai/diagram-to-code/generate-streaming`,
            {
              method: "POST",
              headers: {
                Accept: "text/event-stream",
                "Content-Type": "application/json",
              },
              body: JSON.stringify({
                texts: textFromFrameChildren,
                image: dataURL,
                theme: appState.theme,
              }),
            },
          );

          if (!response.ok) {
            const text = await response.text();
            const errorJSON = safelyParseJSON(text);

            if (!errorJSON) {
              throw new Error(text);
            }

            if (errorJSON.statusCode === 429) {
              return {
                html: `<html>
                <body style="margin: 0; text-align: center">
                <div style="display: flex; align-items: center; justify-content: center; flex-direction: column; height: 100vh; padding: 0 60px">
                  <div style="color:red">Too many requests today,</br>please try again tomorrow!</div>
                  </br>
                  </br>
                  <div>You can also try <a href="${
                    import.meta.env.VITE_APP_PLUS_LP
                  }/plus?utm_source=excalidraw&utm_medium=app&utm_content=d2c" target="_blank" rel="noopener">Excalidraw+</a> to get more requests.</div>
                </div>
                </body>
                </html>`,
              };
            }

            throw new Error(errorJSON.message || text);
          }

          const reader = response.body?.getReader();

          if (!reader) {
            throw new Error("Generation failed (invalid response)");
          }

          let html = "";
          let streamError: Error | null = null;

          for await (const data of parseSSEStream(reader)) {
            if (data === "[DONE]") {
              break;
            }

            const chunk = safelyParseJSON(data) as StreamChunk | null;

            if (!chunk) {
              continue;
            }

            switch (chunk.type) {
              case "content": {
                if (chunk.delta) {
                  html += chunk.delta;
                  onPartial?.(html);
                }
                break;
              }
              case "error": {
                streamError = new Error(
                  chunk.error.message || "Generation failed",
                );
                break;
              }
              case "done": {
                break;
              }
            }
          }

          if (streamError) {
            throw streamError;
          }

          if (!html.trim()) {
            throw new Error("Generation failed (invalid response)");
          }

          return {
            html,
          };
        }}
      />

      <TTDDialog
        // IA local (fork ia-local): em vez do backend do excalidraw.com, o
        // pedido vai direto do navegador para o servidor LLM da máquina
        onTextSubmit={(props) =>
          localLLMStreamFetch({ ...props, config: loadLocalLLMConfig() })
        }
        renderChatHeader={() => <LocalAIStatus />}
        // fase 3: texto -> wireframe de interface, com a mesma IA local
        onWireframeSubmit={({ prompt, previous, signal }) =>
          localLLMWireframeFetch({
            config: loadLocalLLMConfig(),
            prompt,
            previous,
            signal,
          })
        }
        persistenceAdapter={TTDIndexedDBAdapter}
      />
    </>
  );
};
