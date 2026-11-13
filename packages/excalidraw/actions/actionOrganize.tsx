import {
  applyOrganizeLayout,
  CaptureUpdateAction,
  getNonDeletedElements,
  getOrganizeGraph,
  getSelectedElementsByGroup,
  guessOrganizeDirection,
  isFrameLikeElement,
  isOrganizeNodeBucket,
  updateFrameMembershipOfSelectedElements,
} from "@excalidraw/element";
import { CODES } from "@excalidraw/common";

import type { OrganizeDirection } from "@excalidraw/element";

import { IconButton } from "../components/IconButton";
import { OrganizeIcon } from "../components/icons";
import { t } from "../i18n";
import { computeOrganizeLayout } from "../organize/elkLayout";
import { isSomeElementSelected } from "../scene";
import { getShortcutKey } from "../shortcut";

import { register } from "./register";

import type { AppClassProperties, AppState, UIAppState } from "../types";
import type { ActionResult } from "./types";

/**
 * Two or more shapes/groups selected (arrows alone don't count), no frames.
 */
export const organizeActionPredicate = (
  appState: UIAppState,
  app: AppClassProperties,
) => {
  const selectedElements = app.scene.getSelectedElements(appState);
  if (selectedElements.some((element) => isFrameLikeElement(element))) {
    return false;
  }
  return (
    getSelectedElementsByGroup(
      selectedElements,
      app.scene.getNonDeletedElementsMap(),
      appState as Readonly<AppState>,
    ).filter(isOrganizeNodeBucket).length > 1
  );
};

const organizeSelection = async (
  appState: Readonly<AppState>,
  app: AppClassProperties,
  fixedDirection?: OrganizeDirection,
): Promise<ActionResult> => {
  const graph = getOrganizeGraph(
    app.scene.getSelectedElements(appState),
    app.scene.getNonDeletedElementsMap(),
    appState,
  );
  if (graph.nodes.length < 2) {
    return false;
  }

  const direction = fixedDirection ?? guessOrganizeDirection(graph);

  let layout;
  try {
    layout = await computeOrganizeLayout(graph, direction);
  } catch (error) {
    console.error("organize: layout failed", error);
    return {
      appState: {
        ...app.state,
        toast: { message: t("toast.organizeFailed"), closable: true },
      },
      captureUpdate: CaptureUpdateAction.EVENTUALLY,
    };
  }

  // the layout is async: apply it to the scene as it is now
  applyOrganizeLayout(
    graph,
    layout,
    direction,
    app.scene,
    app.renderEnvironment,
  );

  return {
    appState: app.state,
    elements: updateFrameMembershipOfSelectedElements(
      app.scene.getElementsIncludingDeleted(),
      app.state,
      app,
    ),
    captureUpdate: CaptureUpdateAction.IMMEDIATELY,
  };
};

const KEYWORDS = ["layout", "tidy", "arrange", "auto", "organizar", "arrumar"];

/**
 * "Organizar" (fork ia-local): lays out the selected diagram with a graph
 * layout algorithm (ELK "layered"), keeping arrows bound. Keeps the
 * diagram's orientation when it clearly has one, top-to-bottom otherwise.
 */
export const actionOrganize = register({
  name: "organizeElements",
  label: "labels.organize",
  keywords: KEYWORDS,
  icon: OrganizeIcon,
  trackEvent: { category: "element" },
  predicate: (elements, appState, appProps, app) =>
    organizeActionPredicate(appState, app),
  perform: (elements, appState, _, app) => organizeSelection(appState, app),
  keyTest: (event) => event.altKey && event.shiftKey && event.code === CODES.O,
  PanelComponent: ({ elements, appState, updateData, app }) => (
    <IconButton
      hidden={!organizeActionPredicate(appState, app)}
      type="button"
      icon={OrganizeIcon}
      onClick={() => updateData(null)}
      title={`${t("labels.organize")} — ${getShortcutKey("Shift+Alt+O")}`}
      aria-label={t("labels.organize")}
      visible={isSomeElementSelected(getNonDeletedElements(elements), appState)}
    />
  ),
});

/** command palette only: a fixed direction */
export const actionOrganizeTopToBottom = register({
  name: "organizeElementsTopToBottom",
  label: "labels.organizeTopToBottom",
  keywords: [...KEYWORDS, "vertical"],
  icon: OrganizeIcon,
  trackEvent: { category: "element" },
  predicate: (elements, appState, appProps, app) =>
    organizeActionPredicate(appState, app),
  perform: (elements, appState, _, app) =>
    organizeSelection(appState, app, "DOWN"),
});

/** command palette only: a fixed direction */
export const actionOrganizeLeftToRight = register({
  name: "organizeElementsLeftToRight",
  label: "labels.organizeLeftToRight",
  keywords: [...KEYWORDS, "horizontal"],
  icon: OrganizeIcon,
  trackEvent: { category: "element" },
  predicate: (elements, appState, appProps, app) =>
    organizeActionPredicate(appState, app),
  perform: (elements, appState, _, app) =>
    organizeSelection(appState, app, "RIGHT"),
});
