import { arrayToMap, COLOR_WHITE, randomId } from "@excalidraw/common";
import {
  CaptureUpdateAction,
  convertToExcalidrawElements,
  isFreeDrawElement,
  newElementWith,
  syncMovedIndices,
} from "@excalidraw/element";
import { exportScene } from "@excalidraw/utils";

import type {
  ExcalidrawFreeDrawElement,
  NonDeleted,
} from "@excalidraw/element/types";

import { CleanSketchIcon } from "../components/icons";
import { getLanguage, t } from "../i18n";
import {
  analyzeSketch,
  buildCleanSkeletons,
  consumedStrokeIds,
} from "../sketch/cleanSketch";

import { register } from "./register";

import type { AppClassProperties, AppState, UIAppState } from "../types";

type Stroke = NonDeleted<ExcalidrawFreeDrawElement>;

const selectedStrokes = (
  appState: UIAppState | AppState,
  app: AppClassProperties,
) =>
  app.scene
    .getSelectedElements(appState)
    .filter((element): element is Stroke => isFreeDrawElement(element));

/**
 * Handwriting rendered black on white, about 190px tall: small writing is
 * hard to read for a vision model.
 */
const renderInk = (strokes: readonly Stroke[]) => {
  const height =
    Math.max(...strokes.map((stroke) => stroke.y + stroke.height)) -
    Math.min(...strokes.map((stroke) => stroke.y));
  return exportScene({
    type: "png",
    data: {
      elements: strokes.map((stroke) =>
        newElementWith(stroke, {
          strokeColor: "#000000",
          opacity: 100,
          // thin: the image is scaled up, and thick freehand strokes blur
          // letters into blobs
          strokeWidth: 1,
        }),
      ),
      files: null,
    },
    config: {
      padding: 24,
      canvasBackgroundColor: COLOR_WHITE,
      // measured (fase 5): at ~96px the local model misread 2 of 7 labels
      // ("Pagou?" -> "Pergunta?"), at ~190px it read all 7
      scale: Math.min(6, Math.max(1, 192 / Math.max(height, 1))),
    },
  });
};

/**
 * "Limpar rascunho" (fork ia-local, fase 5): selected hand-drawn strokes
 * become a clean diagram: shapes (one stroke each), arrows bound to them, and
 * the handwriting, read by the host's `recognizeHandwriting` (a local vision
 * model in the fork's app), as labels or text. Handwriting that couldn't be
 * read stays as strokes, grouped. One undo step.
 */
export const actionCleanSketch = register({
  name: "cleanSketch",
  label: "labels.cleanSketch",
  keywords: ["sketch", "clean", "rascunho", "limpar", "handwriting", "ink"],
  icon: CleanSketchIcon,
  trackEvent: { category: "element" },
  predicate: (elements, appState, appProps, app) =>
    selectedStrokes(appState, app).length > 0,
  perform: async (elements, appState, _, app) => {
    const strokes = selectedStrokes(appState, app);
    if (!strokes.length) {
      return false;
    }

    const analysis = analyzeSketch(
      strokes,
      appState,
      app.scene.getNonDeletedElementsMap(),
      app.scene.getNonDeletedFramesLikes(),
    );

    const texts = new Map<string, string | null>();
    let warning: string | null = null;
    if (analysis.inks.length) {
      const recognize = app.props.recognizeHandwriting;
      if (!recognize) {
        warning = t("toast.cleanSketchNoReader");
      } else {
        try {
          const images = await Promise.all(
            analysis.inks.map((inkGroup) => renderInk(inkGroup.strokes)),
          );
          const results = await recognize(images, {
            language: getLanguage().code,
          });
          analysis.inks.forEach((inkGroup, i) =>
            texts.set(inkGroup.id, results[i]?.trim() || null),
          );
          if (analysis.inks.some((inkGroup) => !texts.get(inkGroup.id))) {
            warning = t("toast.cleanSketchUnreadable");
          }
        } catch (error: any) {
          warning = t("toast.cleanSketchReaderFailed", {
            reason: String(error?.message ?? error).slice(0, 200),
          });
        }
      }
    }

    const skeletons = buildCleanSkeletons(analysis, texts);
    if (!skeletons.length) {
      return {
        appState: {
          ...app.state,
          toast: { message: warning ?? t("toast.cleanSketchNothing") },
        },
        captureUpdate: CaptureUpdateAction.EVENTUALLY,
      };
    }

    const created = convertToExcalidrawElements(skeletons, {
      regenerateIds: true,
      renderEnvironment: app.renderEnvironment,
    });

    // what couldn't be read stays as strokes, one group per word
    const consumed = consumedStrokeIds(analysis, texts);
    const regroup = new Map<string, string>();
    for (const inkGroup of analysis.inks) {
      if (!texts.get(inkGroup.id) && inkGroup.strokes.length > 1) {
        const groupId = randomId();
        inkGroup.strokes.forEach((stroke) => regroup.set(stroke.id, groupId));
      }
    }

    // the scene as it is now: the reading above is async
    const nextElements = [
      ...app.scene.getElementsIncludingDeleted().map((element) =>
        consumed.has(element.id)
          ? newElementWith(element, { isDeleted: true })
          : regroup.has(element.id)
          ? newElementWith(element, {
              groupIds: [...element.groupIds, regroup.get(element.id)!],
            })
          : element,
      ),
      ...created,
    ];

    return {
      elements: syncMovedIndices(nextElements, arrayToMap(created)),
      appState: {
        ...app.state,
        selectedElementIds: Object.fromEntries(
          created
            .filter(
              (element) => element.type !== "text" || !element.containerId,
            )
            .map((element) => [element.id, true as const]),
        ),
        selectedGroupIds: {},
        ...(warning ? { toast: { message: warning, closable: true } } : {}),
      },
      captureUpdate: CaptureUpdateAction.IMMEDIATELY,
    };
  },
});
